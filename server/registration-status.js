export const REGISTRATION_STATUSES = Object.freeze(['Pending', 'Confirmed', 'Cancelled', 'Attended', 'Declined', 'Withdrawn']);
export const isRegistrationStatus = (status) => REGISTRATION_STATUSES.includes(status);
