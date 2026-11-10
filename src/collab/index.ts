/**
 * Collaboration Engine server barrel export.
 */

export {
  CURRENT_SCHEMA_VERSION,
  CORE_LIMITS as CoreLimits,
  encodeElementId,
  decodeElementId,
  compareElementId,
  elementIdEquals,
} from "./core/types.js";

export * from "./client/index.js";
export * from "./core/index.js";

export type {
  DocumentAcl,
  ActorInfo,
} from "./server/acl.js";
export { AllowAllAcl } from "./server/acl.js";
export { ValidationError } from "./server/validator.js";
export { OpValidator } from "./server/validator.js";
export { OpLog } from "./server/op-log.js";
export type { StoredOperation } from "./server/op-log.js";
export {
  SyncHandler,
  type SyncRequest,
  type SyncResponse,
  type SyncHandlerDeps,
} from "./server/sync-handler.js";
export {
  collaboration,
  type Collaboration,
  type CollaborationOptions,
} from "./server/collaboration.js";
export type { CollaborationStorage } from "./server/storage.js";
export type { DocumentSubscriptions } from "./server/subscriptions.js";
export { MemoryDocumentSubscriptions } from "./server/subscriptions.js";
export type { CollaborationBroadcaster } from "./server/broadcaster.js";
export { MemoryBroadcaster } from "./server/broadcaster.js";
export type {
  DocumentScope,
  operationKey,
} from "./server/document-key.js";
export { documentScopeKey } from "./server/document-key.js";
export type { AuthenticatedPrincipal } from "./server/principal.js";
export {
  Document,
  type DocumentState,
  type AwarenessPeer,
} from "./client/document.js";
