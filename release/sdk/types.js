"use strict";
//! Type definitions for Hexactra
Object.defineProperty(exports, "__esModule", { value: true });
exports.InteractionStatus = exports.InteractionKind = exports.OperationStatus = exports.SessionStatus = exports.RunStatus = exports.ErrorCode = void 0;
/**
 * Error codes for Hexactra SDK errors
 */
var ErrorCode;
(function (ErrorCode) {
    ErrorCode["InvalidInput"] = "INVALID_INPUT";
    ErrorCode["Unauthorized"] = "UNAUTHORIZED";
    ErrorCode["Forbidden"] = "FORBIDDEN";
    ErrorCode["NotFound"] = "NOT_FOUND";
    ErrorCode["Conflict"] = "CONFLICT";
    ErrorCode["RateLimit"] = "RATE_LIMIT";
    ErrorCode["InternalError"] = "INTERNAL_ERROR";
    ErrorCode["NetworkError"] = "NETWORK_ERROR";
    ErrorCode["TimeoutError"] = "TIMEOUT_ERROR";
})(ErrorCode || (exports.ErrorCode = ErrorCode = {}));
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
// ==================== HITL Types ====================
var InteractionKind;
(function (InteractionKind) {
    InteractionKind["SecretText"] = "secret_text";
    InteractionKind["OtpCode"] = "otp_code";
    InteractionKind["OobConfirmation"] = "oob_confirmation";
    InteractionKind["PasskeyOrSecurityKey"] = "passkey_or_security_key";
    InteractionKind["ActionApproval"] = "action_approval";
    InteractionKind["HumanTakeover"] = "human_takeover";
    InteractionKind["Information"] = "information";
})(InteractionKind || (exports.InteractionKind = InteractionKind = {}));
var InteractionStatus;
(function (InteractionStatus) {
    InteractionStatus["Pending"] = "pending";
    InteractionStatus["Approved"] = "approved";
    InteractionStatus["Rejected"] = "rejected";
    InteractionStatus["Expired"] = "expired";
    InteractionStatus["Cancelled"] = "cancelled";
})(InteractionStatus || (exports.InteractionStatus = InteractionStatus = {}));
//# sourceMappingURL=types.js.map