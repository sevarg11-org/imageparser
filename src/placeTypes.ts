/** A place found by the place search, with its coordinates. */
export type Place = {
  id: string;
  name: string;
  locality: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
};

/** The place saved in an image's XMP sidecar. */
export type PlaceLocation = {
  latitude: number;
  longitude: number;
  name: string;
};

/** Describes a place on one line, for example "Lincoln High School, Chicago, Illinois, United States". */
export const describePlace = (
  place: Omit<Place, "id" | "latitude" | "longitude">,
) =>
  [place.name, place.locality, place.region, place.country]
    .filter((part, index, parts) => part && parts.indexOf(part) === index)
    .join(", ");

export const toPlaceLocation = (place: Place): PlaceLocation => ({
  latitude: place.latitude,
  longitude: place.longitude,
  name: describePlace(place),
});
