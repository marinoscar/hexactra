"use strict";
//! Type definitions for Hexactra
Object.defineProperty(exports, "__esModule", { value: true });
exports.OperationStatus = exports.SessionStatus = exports.RunStatus = void 0;
var RunStatus;
(function (RunStatus) {
    RunStatus["Queued"] = "queued";
    RunStatus["Running"] = "running";
    RunStatus["Completed"] = "completed";
    RunStatus["Failed"] = "failed";
    RunStatus["Cancelled"] = "cancelled";
    RunStatus["TimedOut"] = "timed_out";
})(RunStatus || (exports.RunStatus = RunStatus = {}));
var SessionStatus;
(function (SessionStatus) {
    SessionStatus["Initializing"] = "initializing";
    SessionStatus["Running"] = "running";
    SessionStatus["Paused"] = "paused";
    SessionStatus["Ended"] = "ended";
})(SessionStatus || (exports.SessionStatus = SessionStatus = {}));
var OperationStatus;
(function (OperationStatus) {
    OperationStatus["Queued"] = "queued";
    OperationStatus["InProgress"] = "in_progress";
    OperationStatus["Completed"] = "completed";
    OperationStatus["Failed"] = "failed";
})(OperationStatus || (exports.OperationStatus = OperationStatus = {}));
//# sourceMappingURL=types.js.map