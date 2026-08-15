export const INVITATION_STATUSES = Object.freeze(['Pending', 'Accepted', 'Declined']);
export const isInvitationStatus = (status) => INVITATION_STATUSES.includes(status);
