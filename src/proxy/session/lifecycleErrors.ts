export class SessionLifecycleError extends Error {}
export class SessionLifecycleLockError extends SessionLifecycleError {}
export class SessionLifecycleCorruptError extends SessionLifecycleError {}
export class SessionLifecycleBacklogError extends SessionLifecycleError {}
export class SessionLifecycleQueueCapacityError extends SessionLifecycleLockError {}
export class SessionLifecycleQueueStalledError extends SessionLifecycleLockError {}
export class SessionLifecycleReentrancyError extends SessionLifecycleError {}
