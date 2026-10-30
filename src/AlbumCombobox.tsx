import { useCallback, useEffect, useId, useState } from "react";
import { buildAlbumOptions, resolveAlbumName } from "./albumOptions";
import {
  loadImmichAlbums,
  type ImmichAlbum,
  type ImmichLookupSettings,
} from "./webApi";
import "./AlbumCombobox.css";

type AlbumComboboxProps = {
  value: string;
  onChange: (albumName: string) => void;
  disabled: boolean;
  /** The Immich URL and key in the form. The list reloads shortly after either changes. */
  settings: ImmichLookupSettings;
};

/**
 * Target-album field for the web app: a combobox over the user's Immich albums that still accepts a new name.
 * When the album lookup fails it stays a plain text input and shows the reason, so uploading is never blocked.
 */
function AlbumCombobox({
  value,
  onChange,
  disabled,
  settings,
}: AlbumComboboxProps) {
  const id = useId();
  const listboxId = `${id}-listbox`;
  const errorId = `${id}-error`;
  const [albums, setAlbums] = useState<ImmichAlbum[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const applyResult = useCallback((result: ImmichAlbum[] | Error) => {
    if (result instanceof Error) {
      setAlbums([]);
      setErrorMessage(result.message || "Albums could not be loaded.");
    } else {
      setAlbums(result);
      setErrorMessage("");
    }
    setHasLoaded(true);
    setIsLoading(false);
  }, []);

  const toResult = (error: unknown) =>
    error instanceof Error ? error : new Error("Albums could not be loaded.");

  const { serverUrl, userApiKey } = settings;

  const refresh = () => {
    setIsLoading(true);
    loadImmichAlbums({ serverUrl, userApiKey }, true).then(
      applyResult,
      (error) => applyResult(toResult(error)),
    );
  };

  // Loads when the section appears and again shortly after the URL or key is edited, using the form's
  // values because they are only saved when an upload starts.
  useEffect(() => {
    let isCurrent = true;
    const timer = window.setTimeout(() => {
      loadImmichAlbums({ serverUrl, userApiKey }).then(
        (result) => isCurrent && applyResult(result),
        (error) => isCurrent && applyResult(toResult(error)),
      );
    }, 600);
    return () => {
      isCurrent = false;
      window.clearTimeout(timer);
    };
  }, [applyResult, serverUrl, userApiKey]);

  const options = errorMessage ? [] : buildAlbumOptions(albums, value);
  const showList = isOpen && options.length > 0;

  // Keeps the highlighted option visible when arrow keys move past the edge of a scrolling list.
  useEffect(() => {
    if (showList) {
      document
        .getElementById(`${id}-option-${activeIndex}`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [showList, activeIndex, id]);
  const activeOption = options[Math.min(activeIndex, options.length - 1)];

  const choose = (albumName: string) => {
    onChange(resolveAlbumName(albums, albumName));
    setIsOpen(false);
  };

  return (
    <div className="album-combobox">
      <label>
        Target album
        <input
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            showList ? `${id}-option-${activeIndex}` : undefined
          }
          aria-describedby={errorMessage ? errorId : undefined}
          autoComplete="off"
          value={value}
          required
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value);
            setActiveIndex(0);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onBlur={() => setIsOpen(false)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setIsOpen(true);
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActiveIndex(
                (index) =>
                  (index + step + Math.max(options.length, 1)) %
                  Math.max(options.length, 1),
              );
            } else if (event.key === "Enter" && showList && activeOption) {
              event.preventDefault();
              choose(activeOption.albumName);
            } else if (event.key === "Escape" && isOpen) {
              event.preventDefault();
              setIsOpen(false);
            }
          }}
        />
      </label>
      <button
        type="button"
        className="album-combobox-refresh"
        onClick={refresh}
        disabled={disabled || isLoading}
      >
        {isLoading ? "Loading albums…" : "Refresh albums"}
      </button>
      <span role="status" className="field-help">
        {hasLoaded && !errorMessage && !isLoading
          ? albums.length
            ? `${albums.length} album${albums.length === 1 ? "" : "s"} available. Click the field to choose one.`
            : "No albums found. Type a name to create one."
          : ""}
      </span>
      {showList ? (
        <ul id={listboxId} role="listbox" aria-label="Immich albums">
          {options.map((option, index) => (
            <li
              key={`${option.kind}-${option.albumName}`}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "active" : undefined}
              // Pointer movement (not mere presence) moves the highlight, so keyboard scrolling is not hijacked.
              onMouseMove={() => setActiveIndex(index)}
              // mousedown keeps focus in the input so blur does not close the list before the click lands.
              onMouseDown={(event) => {
                event.preventDefault();
                choose(option.albumName);
              }}
            >
              {option.kind === "create" ? (
                <>Create new album “{option.albumName}”</>
              ) : (
                <>
                  {option.albumName}
                  <span className="album-combobox-meta">
                    {option.assetCount} items
                    {option.shared ? " · shared" : ""}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {errorMessage ? (
        <p id={errorId} role="alert" className="album-combobox-error">
          {errorMessage} Type the album name instead.
        </p>
      ) : null}
    </div>
  );
}

export default AlbumCombobox;
