import { registerErrorCode } from '@marinoscar/platform-api/core';

// The Knowledge Graph error codes (E46.3, #777). The platform's filter passes a `code` through only when it is registered for the status.
registerErrorCode({ code: 'KGRAPH_TASK_NOT_FOUND', status: 404, description: "The task does not exist or is not the caller's." });
registerErrorCode({ code: 'KGRAPH_OFF', status: 409, description: 'The Knowledge Graph is turned off by your administrator (`kgraph.enabled` in the system settings) or by you (`kgraph.enabled` in your settings): turn it on before choosing a task mode.' });
registerErrorCode({ code: 'KGRAPH_PROCEDURE_NOT_FOUND', status: 404, description: "The procedure does not exist or is not the caller's." });
registerErrorCode({ code: 'KGRAPH_VERSION_NOT_RESTORABLE', status: 409, description: 'Only a retired or suspended version of this procedure can be restored.' });
