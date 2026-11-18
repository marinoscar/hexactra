-- CreateTable
CREATE TABLE "rate_limit_windows" (
    "key" VARCHAR(255) NOT NULL,
    "window_ms" INTEGER NOT NULL,
    "window_start" TIMESTAMPTZ NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rate_limit_windows_pkey" PRIMARY KEY ("key","window_ms","window_start")
);

-- CreateIndex
CREATE INDEX "rate_limit_windows_expires_at_idx" ON "rate_limit_windows"("expires_at");
