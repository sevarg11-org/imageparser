import {
  useEffect,
  useId,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { toPlaceLocation, type Place, type PlaceLocation } from "./placeTypes";
import "./LocationPicker.css";

type LocationPickerProps = {
  id: string;
  /** The place currently chosen, or null for none. */
  value: PlaceLocation | null;
  onChange: (location: PlaceLocation | null) => void;
  disabled: boolean;
  /** Puts the search field above the chosen place instead of beside it, for narrow dialogs. */
  stacked?: boolean;
};

/**
 * Chooses a place by name. A search runs only when the user presses Enter or Search, never while typing, and
 * choosing a result makes no further call because the coordinates are already in the result. "Recent places"
 * come from the local store.
 */
function LocationPicker({
  id,
  value,
  onChange,
  disabled,
  stacked = false,
}: LocationPickerProps) {
  const generatedId = useId();
  const resultsId = `${generatedId}-results`;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [recentPlaces, setRecentPlaces] = useState<Place[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let isMounted = true;
    window.electronAPI?.getRecentPlaces().then(
      (places) => isMounted && setRecentPlaces(places),
      () => undefined,
    );
    return () => {
      isMounted = false;
    };
  }, []);

  const search = async () => {
    const electronApi = window.electronAPI;
    if (!electronApi || !query.trim() || isSearching) {
      return;
    }
    setIsSearching(true);
    setErrorMessage("");
    try {
      setResults(await electronApi.searchPlaces(query));
    } catch (error) {
      setResults(null);
      setErrorMessage(
        error instanceof Error ? error.message : "The place search failed.",
      );
    } finally {
      setIsSearching(false);
    }
  };

  const choose = (place: Place) => {
    onChange(toPlaceLocation(place));
    setResults(null);
    setQuery("");
    // Saved locally for the "Recent places" list; this makes no geocoder call.
    void window.electronAPI?.rememberPlace(place).then(
      (saved) =>
        setRecentPlaces((current) => [
          saved,
          ...current.filter((recent) => recent.id !== saved.id),
        ]),
      () => undefined,
    );
  };

  const handleOptionKeyDown = (
    event: ReactKeyboardEvent<HTMLLIElement>,
    place: Place,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(place);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      (event.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      (
        event.currentTarget.previousElementSibling as HTMLElement | null
      )?.focus();
    }
  };

  const renderOptions = (places: Place[], label: string) => (
    <ul
      role="listbox"
      aria-label={label}
      id={label === "Search results" ? resultsId : undefined}
    >
      {places.map((place) => (
        <li
          key={place.id}
          role="option"
          aria-selected={false}
          tabIndex={0}
          onClick={() => choose(place)}
          onKeyDown={(event) => handleOptionKeyDown(event, place)}
        >
          <span className="location-picker-name">{place.name}</span>
          <span className="location-picker-detail">
            {[place.locality, place.region, place.country]
              .filter((part, i, parts) => part && parts.indexOf(part) === i)
              .join(", ")}
          </span>
        </li>
      ))}
    </ul>
  );

  return (
    <div
      className={`location-picker${stacked ? " location-picker--stacked" : ""}`}
    >
      <div className="detail-box-row">
        <div className="tag-entry location-picker-search">
          <input
            id={id}
            type="text"
            value={query}
            placeholder="Search for a place"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void search();
              }
            }}
            disabled={disabled}
            aria-describedby={`${generatedId}-status`}
            aria-controls={results ? resultsId : undefined}
          />
          <button
            type="button"
            className="secondary-button"
            onClick={() => void search()}
            disabled={disabled || isSearching || query.trim().length < 3}
          >
            {isSearching ? "Searching…" : "Search"}
          </button>
        </div>

        {value ? (
          <div className="selected-tags" aria-label="Chosen location">
            <button
              type="button"
              onClick={() => onChange(null)}
              disabled={disabled}
              aria-label={`Clear location ${value.name || "chosen place"}`}
              title={`${value.latitude.toFixed(4)}, ${value.longitude.toFixed(4)}`}
            >
              {value.name || "Chosen place"}{" "}
              <span aria-hidden="true">&times;</span>
            </button>
          </div>
        ) : (
          <p className="field-help">No location set.</p>
        )}
      </div>

      <div
        id={`${generatedId}-status`}
        aria-live="polite"
        className="field-help"
      >
        {isSearching
          ? "Searching…"
          : results && !results.length
            ? "No places found. Try a different name."
            : results
              ? `${results.length} place${results.length === 1 ? "" : "s"} found.`
              : "Press Enter or Search. At least 3 characters."}
      </div>
      {errorMessage ? (
        <p role="alert" className="location-picker-error">
          {errorMessage}
        </p>
      ) : null}

      {results?.length ? renderOptions(results, "Search results") : null}

      {recentPlaces.length && !results ? (
        <div className="location-picker-recent">
          <h4>Recent places</h4>
          {renderOptions(recentPlaces, "Recent places")}
        </div>
      ) : null}

      <p className="field-help">
        Place search uses data © OpenStreetMap contributors.
      </p>
    </div>
  );
}

export default LocationPicker;
