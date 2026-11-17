export function createVenuesPresentation({ protectedMediaUrl, venueFtpService, venueImageToken }) {
  const venueImageUrl = (filename, token = null) =>
    token
      ? protectedMediaUrl('venue', filename, token)
      : `${venueFtpService.publicPath()}/${encodeURIComponent(filename)}`;
  const decorateVenueImages = (venue) => {
    if (!venue) return venue;
    const tokenFor =
      venue.canManage && !(venue.isActive && venue.moderationStatus === 'approved')
        ? venueImageToken
        : () => null;
    return {
      ...venue,
      coverImageUrl: venue.coverImage
        ? venueImageUrl(venue.coverImage, tokenFor(venue.coverImage))
        : null,
      ...(venue.images
        ? {
            images: venue.images.map((image) => ({
              ...image,
              url: venueImageUrl(image.filename, tokenFor(image.filename)),
            })),
          }
        : {}),
    };
  };
  const sendVenue = (res, venue, status = 200) =>
    res.status(status).json(decorateVenueImages(venue));
  const sendVenueList = (res, venues) => res.json(venues.map(decorateVenueImages));
  return { venueImageUrl, sendVenue, sendVenueList };
}
