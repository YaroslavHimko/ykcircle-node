export const PUBLISH_EVENT = 'organizer.publish_event';
export const PUBLISH_ARTICLE = 'author.publish_article';
export const PRODUCT_DEFAULTS = Object.freeze({
  subscriptionsEnabled: false,
  paidEventsEnabled: false,
  paidVenuesEnabled: false,
  paidServicesEnabled: false,
  articlesPerMonth: 1,
});
export const accessError = (code, message, status = 403, details = {}) =>
  Object.assign(new Error(message), { code, status, ...details });
export const ownerKey = (owner) => `${owner.type}:${owner.id}`;
export const parseOwner = (value, userId) => {
  const owner = value ?? { type: 'user', id: userId };
  if (
    !['user', 'organization'].includes(owner.type) ||
    !Number.isSafeInteger(Number(owner.id)) ||
    Number(owner.id) < 1
  )
    throw accessError('INVALID_OWNER', 'Choose a valid organizer.', 422);
  return { type: owner.type, id: Number(owner.id) };
};
