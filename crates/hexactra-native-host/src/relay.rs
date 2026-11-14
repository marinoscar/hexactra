//! Relay between Chrome's native messaging stdio and the agent socket.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use hexactra_core::bridge::{read_frame, write_frame, MAX_FROM_EXTENSION, MAX_TO_EXTENSION};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::mpsc;

/// Read one Chrome native messaging frame (native-endian length, which is
/// little-endian on every platform Chrome supports). `Ok(None)` on EOF.
pub async fn read_chrome_frame<R: AsyncRead + Unpin>(r: &mut R) -> Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let len = u32::from_ne_bytes(len) as usize;
    if len > MAX_FROM_EXTENSION {
        anyhow::bail!("message from extension too large: {len} bytes");
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    Ok(Some(buf))
}

/// Write one Chrome native messaging frame.
pub async fn write_chrome_frame<W: AsyncWrite + Unpin>(w: &mut W, payload: &[u8]) -> Result<()> {
    if payload.len() > MAX_TO_EXTENSION {
        anyhow::bail!("message to extension too large: {} bytes", payload.len());
    }
    w.write_all(&(payload.len() as u32).to_ne_bytes()).await?;
    w.write_all(payload).await?;
    w.flush().await?;
    Ok(())
}

fn frame_type(frame: &[u8]) -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(frame)
        .ok()?
        .get("type")?
        .as_str()
        .map(str::to_string)
}

/// Run the relay until the extension closes stdin.
pub async fn run<R, W>(stdin: R, stdout: W, socket: PathBuf, retry: Duration) -> Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    // Extension -> relay.
    let (from_ext_tx, mut from_ext) = mpsc::channel::<Vec<u8>>(64);
    tokio::spawn(async move {
        let mut stdin = stdin;
        loop {
            match read_chrome_frame(&mut stdin).await {
                Ok(Some(f)) => {
                    if from_ext_tx.send(f).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    tracing::error!(error = %e, "reading from extension failed");
                    break;
                }
            }
        }
    });

    // Relay -> extension.
    let (to_ext, mut to_ext_rx) = mpsc::channel::<Vec<u8>>(64);
    let writer = tokio::spawn(async move {
        let mut stdout = stdout;
        while let Some(f) = to_ext_rx.recv().await {
            if let Err(e) = write_chrome_frame(&mut stdout, &f).await {
                tracing::error!(error = %e, "writing to extension failed");
                if e.to_string().contains("too large") {
                    continue;
                }
                break;
            }
        }
    });

    let mut hello: Option<Vec<u8>> = None;
    'outer: loop {
        // Wait for the agent, answering pings and remembering hello meanwhile.
        let stream = loop {
            match UnixStream::connect(&socket).await {
                Ok(s) => break s,
                Err(_) => {
                    let sleep = tokio::time::sleep(retry);
                    tokio::pin!(sleep);
                    loop {
                        tokio::select! {
                            _ = &mut sleep => break,
                            f = from_ext.recv() => match f {
                                None => break 'outer,
                                Some(f) => match frame_type(&f).as_deref() {
                                    Some("hello") => hello = Some(f),
                                    Some("ping") => { let _ = to_ext.send(br#"{"type":"pong"}"#.to_vec()).await; }
                                    _ => tracing::debug!("dropping frame while agent is unavailable"),
                                },
                            },
                        }
                    }
                }
            }
        };
        tracing::info!("connected to host agent");
        let (mut rd, mut wr) = stream.into_split();
        if let Some(h) = &hello {
            if write_frame(&mut wr, h, MAX_FROM_EXTENSION).await.is_err() {
                continue;
            }
        }
        let _ = to_ext.send(br#"{"type":"agent_connected"}"#.to_vec()).await;

        // Agent -> extension pump for this connection.
        let to_ext2 = to_ext.clone();
        let mut pump = tokio::spawn(async move {
            loop {
                match read_frame(&mut rd, MAX_TO_EXTENSION).await {
                    Ok(Some(f)) => {
                        if to_ext2.send(f).await.is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        tracing::warn!(error = %e, "reading from agent failed");
                        break;
                    }
                }
            }
        });

        loop {
            tokio::select! {
                _ = &mut pump => break,
                f = from_ext.recv() => match f {
                    None => { pump.abort(); break 'outer; }
                    Some(f) => {
                        if frame_type(&f).as_deref() == Some("hello") {
                            hello = Some(f.clone());
                        }
                        if let Err(e) = write_frame(&mut wr, &f, MAX_FROM_EXTENSION).await {
                            tracing::warn!(error = %e, "writing to agent failed");
                            pump.abort();
                            break;
                        }
                    }
                },
            }
        }
        tracing::info!("host agent disconnected; reconnecting");
        let _ = to_ext
            .send(br#"{"type":"agent_disconnected"}"#.to_vec())
            .await;
    }
    drop(to_ext);
    let _ = writer.await;
    tracing::info!("extension closed the connection; exiting");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::UnixListener;

    async fn ext_send<W: AsyncWrite + Unpin>(w: &mut W, v: serde_json::Value) {
        write_chrome_frame(w, v.to_string().as_bytes())
            .await
            .unwrap();
    }

    async fn ext_recv<R: AsyncRead + Unpin>(r: &mut R) -> serde_json::Value {
        let f = tokio::time::timeout(Duration::from_secs(5), read_chrome_frame(r))
            .await
            .expect("timed out waiting for frame")
            .unwrap()
            .unwrap();
        serde_json::from_slice(&f).unwrap()
    }

    #[tokio::test]
    async fn chrome_framing_round_trip() {
        let (mut a, mut b) = tokio::io::duplex(64);
        write_chrome_frame(&mut a, b"{}").await.unwrap();
        assert_eq!(read_chrome_frame(&mut b).await.unwrap().unwrap(), b"{}");
        assert!(
            write_chrome_frame(&mut a, &vec![b' '; MAX_TO_EXTENSION + 1])
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn relays_both_ways_and_survives_agent_restart() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("bridge.sock");

        // Fake extension on a pair of duplex pipes.
        let (mut ext_w, relay_stdin) = tokio::io::duplex(1 << 16);
        let (relay_stdout, mut ext_r) = tokio::io::duplex(1 << 16);
        let relay = tokio::spawn(run(
            relay_stdin,
            relay_stdout,
            sock.clone(),
            Duration::from_millis(20),
        ));

        // Extension says hello and pings before any agent exists.
        ext_send(
            &mut ext_w,
            serde_json::json!({"type": "hello", "version": "t"}),
        )
        .await;
        ext_send(&mut ext_w, serde_json::json!({"type": "ping"})).await;
        assert_eq!(ext_recv(&mut ext_r).await["type"], "pong");

        for round in 0..2 {
            let listener = UnixListener::bind(&sock).unwrap();
            let (mut agent, _) = listener.accept().await.unwrap();
            // Hello is replayed on every connection.
            let f = read_frame(&mut agent, 1 << 20).await.unwrap().unwrap();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&f).unwrap()["type"],
                "hello"
            );
            assert_eq!(ext_recv(&mut ext_r).await["type"], "agent_connected");

            // Agent -> extension.
            let req = serde_json::json!({"type": "request", "id": format!("op{round}"), "action": {"type": "tabs"}});
            write_frame(&mut agent, req.to_string().as_bytes(), 1 << 20)
                .await
                .unwrap();
            assert_eq!(ext_recv(&mut ext_r).await["id"], format!("op{round}"));

            // Extension -> agent.
            ext_send(
                &mut ext_w,
                serde_json::json!({"type": "response", "id": format!("op{round}"), "ok": true}),
            )
            .await;
            let f = read_frame(&mut agent, 1 << 20).await.unwrap().unwrap();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&f).unwrap()["ok"],
                true
            );

            // Agent goes away; extension is told.
            drop(agent);
            drop(listener);
            std::fs::remove_file(&sock).unwrap();
            assert_eq!(ext_recv(&mut ext_r).await["type"], "agent_disconnected");
        }

        // Extension closing stdin ends the relay.
        drop(ext_w);
        tokio::time::timeout(Duration::from_secs(5), relay)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}
