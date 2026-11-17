export function registerMediaEventsAndVenuesRoutes(
  app,
  {
    publicMediaRoute,
    venueUploadRoute,
    mediaVisibility,
    mediaStream,
    venueFtpService,
    eventUploadRoute,
    eventFtpService,
    protectedMediaRoute,
  },
) {
  publicMediaRoute({
    route: venueUploadRoute,
    label: 'Venue',
    visible: mediaVisibility('venueImageVisible'),
    stream: mediaStream(venueFtpService, 'streamVenueImage'),
    message: 'Image not found.',
  });
  publicMediaRoute({
    route: eventUploadRoute,
    label: 'Event',
    visible: mediaVisibility('eventCoverVisible'),
    stream: mediaStream(eventFtpService, 'streamEventCover'),
    message: 'Image not found.',
  });
  protectedMediaRoute({
    kind: 'venue',
    tokenKind: 'venue-image',
    visible: mediaVisibility('venueImageVisible'),
    stream: mediaStream(venueFtpService, 'streamVenueImage'),
    message: 'Image not found.',
  });
  protectedMediaRoute({
    kind: 'event',
    tokenKind: 'event-cover',
    visible: mediaVisibility('eventCoverVisible'),
    stream: mediaStream(eventFtpService, 'streamEventCover'),
    message: 'Image not found.',
  });
}
