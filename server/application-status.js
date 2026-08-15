export const APPLICATION_STATUSES = Object.freeze([
  'New',
  'Approved',
  'In Progress',
  'Contacted',
  'Contact Again',
  'Ordered',
  'Declined',
]);

export const isApplicationStatus = (status) => APPLICATION_STATUSES.includes(status);
