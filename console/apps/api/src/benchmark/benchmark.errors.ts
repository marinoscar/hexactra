import { registerErrorCode } from '@marinoscar/platform-api/core';

// Benchmark error codes (E44.3, #741), registered once at module load.
registerErrorCode({ code: 'BENCHMARK_NOT_FOUND', status: 404, description: "The benchmark does not exist or is not the caller's." });
registerErrorCode({ code: 'BENCHMARK_RUNNING', status: 409, description: 'A benchmark is already running on that node and profile; or the benchmark is still running and must be cancelled before it is deleted.' });
registerErrorCode({ code: 'BENCHMARK_SITE_UNREACHABLE', status: 400, description: "A node cannot reach the challenge site's address: set the console's public URL or the system setting benchmark.siteBaseUrl." });
registerErrorCode({ code: 'BENCHMARK_HOST_UNAVAILABLE', status: 400, description: 'The node chosen for the benchmark could not be checked: the fabric did not answer.' });
registerErrorCode({ code: 'BENCHMARK_HOST_NOT_FOUND', status: 400, description: 'The node chosen for the benchmark is not in the fleet.' });
registerErrorCode({ code: 'CHALLENGE_UNKNOWN', status: 400, description: 'The suite has no challenge with that id; the message names it.' });
registerErrorCode({ code: 'POLICY_DUPLICATE', status: 400, description: 'A benchmark lists each agent policy once, each with its own label.' });
