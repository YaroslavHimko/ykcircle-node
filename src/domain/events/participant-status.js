export const PARTICIPANT_STATUSES = Object.freeze(['Pending', 'Attended', 'No Show']);
export const isParticipantStatus = (status) => PARTICIPANT_STATUSES.includes(status);
