export const EVENT_STATUSES = Object.freeze(['Draft', 'Published', 'Cancelled', 'Completed', 'Archived']);
export const isEventStatus = (status) => EVENT_STATUSES.includes(status);
