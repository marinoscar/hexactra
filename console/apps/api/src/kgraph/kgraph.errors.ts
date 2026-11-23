import { registerErrorCode } from '@marinoscar/platform-api/core';

// The Knowledge Graph error codes (E46.3, #777). The platform's filter passes a `code` through only when it is registered for the status.
registerErrorCode({ code: 'KGRAPH_TASK_NOT_FOUND', status: 404, description: "The task does not exist or is not the caller's." });
registerErrorCode({ code: 'KGRAPH_OFF', status: 409, description: 'The Knowledge Graph is turned off by your administrator (`kgraph.enabled` in the system settings) or by you (`kgraph.enabled` in your settings): turn it on before choosing a task mode.' });
registerErrorCode({ code: 'KGRAPH_PROCEDURE_NOT_FOUND', status: 404, description: "The procedure does not exist or is not the caller's." });
registerErrorCode({ code: 'KGRAPH_VERSION_NOT_RESTORABLE', status: 409, description: 'Only a retired or suspended version of this procedure can be restored.' });
registerErrorCode({ code: 'KGRAPH_REVIEW_NOT_FOUND', status: 404, description: "The review does not exist or is not the caller's." });
registerErrorCode({ code: 'KGRAPH_REVIEW_ANSWERED', status: 409, description: 'The review was already answered or has expired.' });
registerErrorCode({ code: 'KGRAPH_REVIEW_CONSOLE_ONLY', status: 403, description: 'A Knowledge Graph review is answered only by the owner signed in to the console: not with a token, an OAuth app or MCP.' });
registerErrorCode({ code: 'KGRAPH_VERSION_NOT_FOUND', status: 404, description: "The procedure has no version with that number, or the procedure is not the caller's." });
registerErrorCode({ code: 'KGRAPH_RUN_NOT_FOUND', status: 404, description: "The run does not exist or is not the caller's." });
registerErrorCode({ code: 'KGRAPH_IMPORT_INVALID', status: 400, description: 'The file is not a Knowledge Graph file this console can read: malformed, a newer formatVersion, or over a limit. `details.reason` says which. Nothing was imported.' });
registerErrorCode({ code: 'KGRAPH_SITE_FACT_NOT_FOUND', status: 404, description: "The site fact does not exist or is not the caller's." });
registerErrorCode({ code: 'KGRAPH_SITE_FACT_REFUSED', status: 422, description: 'A site fact never holds a password, code, token or full card, account or ID number, never an instruction and never a link to another site. `details.rules` names the rules it broke (`secret`, `instruction`, `domain`, `length`, `schema`); its text is not echoed.' });
registerErrorCode({ code: 'KGRAPH_SITE_FACT_EXISTS', status: 409, description: 'The edit would make the fact the same as another of your facts about this site.' });
registerErrorCode({ code: 'KGRAPH_SITE_FACT_STATUS', status: 409, description: 'That status move is not allowed: a proposal is approved in Knowledge Graph reviews; an archived fact is restored to active.' });
