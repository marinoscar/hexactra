import { registerErrorCode } from '@marinoscar/platform-api/core';

// The schedule and task-list routes' domain error codes (registered once, at
// import; the exception filter passes a payload `code` through only when it is
// registered for the exception's status). A 400 for one item of a `schedules[]`
// body also carries `details.path`, e.g. `schedules[1].cron`.
registerErrorCode({ code: 'INVALID_CRON', status: 400, description: 'Not a 5-field cron expression.' });
registerErrorCode({ code: 'INVALID_TIMEZONE', status: 400, description: 'Not an IANA time zone this server knows.' });
registerErrorCode({ code: 'CRON_TOO_FREQUENT', status: 400, description: 'A schedule may fire at most every 5 minutes.' });
registerErrorCode({ code: 'SCHEDULE_NOT_IN_TASK', status: 400, description: "A schedule id in a task's schedule set is not one of that task's schedules, or is listed twice." });
registerErrorCode({ code: 'INVALID_TASK_CURSOR', status: 400, description: 'The task list cursor is not one this server issued for the same `sort`.' });
registerErrorCode({ code: 'SCHEDULE_LIMIT', status: 409, description: 'A task has at most 10 schedules.' });
registerErrorCode({ code: 'NO_SCHEDULES', status: 409, description: 'The task has no schedule to pause or resume.' });
