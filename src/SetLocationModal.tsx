import { useEffect, useRef, useState } from "react";
import LocationPicker from "./LocationPicker";
import type { PlaceLocation } from "./placeTypes";
import "./SetFolderDateModal.css";

type SetLocationModalProps = {
  isOpen: boolean;
  selectedCount: number;
  isSubmitting: boolean;
  /** Per-image failures from the last attempt, listed so they can be retried. */
  failures: string[];
  /** Counts the selected groups that already have a location (they would be replaced). */
  countExisting: () => Promise<number>;
  onConfirm: (location: PlaceLocation) => void;
  onClose: () => void;
};

const SetLocationDialogContent = ({
  selectedCount,
  isSubmitting,
  failures,
  countExisting,
  onConfirm,
  onClose,
}: Omit<SetLocationModalProps, "isOpen">) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [location, setLocation] = useState<PlaceLocation | null>(null);
  const [replaceCount, setReplaceCount] = useState<number | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [checkError, setCheckError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  const handleApply = async () => {
    if (!location) {
      return;
    }
    // Replacing existing locations needs a second, explicit confirmation showing how many are affected.
    if (replaceCount === null) {
      setIsChecking(true);
      setCheckError("");
      try {
        const existing = await countExisting();
        if (existing > 0) {
          setReplaceCount(existing);
          return;
        }
      } catch (error) {
        setCheckError(
          error instanceof Error
            ? error.message
            : "Existing locations could not be checked.",
        );
        return;
      } finally {
        setIsChecking(false);
      }
    }
    onConfirm(location);
  };

  return (
    <dialog
      ref={dialogRef}
      className="set-folder-date-dialog add-tags-dialog"
      aria-labelledby="set-location-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!isSubmitting) {
          onClose();
        }
      }}
    >
      <header className="set-folder-date-header">
        <h2 id="set-location-title">Set Location for Selected</h2>
        <p className="set-folder-date-subtitle">
          Apply one place to the {selectedCount} selected photo group
          {selectedCount === 1 ? "" : "s"}. Dates, descriptions and tags are
          kept.
        </p>
      </header>

      <div className="set-folder-date-body">
        <label htmlFor="set-location-search">Place</label>
        <LocationPicker
          id="set-location-search"
          stacked
          value={location}
          onChange={(next) => {
            setLocation(next);
            setReplaceCount(null);
          }}
          disabled={isSubmitting || isChecking}
        />

        {replaceCount !== null ? (
          <p role="alert" className="set-folder-date-error">
            {replaceCount} of the {selectedCount} selected photo group
            {selectedCount === 1 ? "" : "s"} already{" "}
            {replaceCount === 1 ? "has" : "have"} a location. Applying will
            replace {replaceCount === 1 ? "it" : "them"}.
          </p>
        ) : null}
        {checkError ? (
          <p role="alert" className="set-folder-date-error">
            {checkError}
          </p>
        ) : null}
        {failures.length ? (
          <div role="alert" className="set-folder-date-error">
            <p>
              {failures.length} photo group{failures.length === 1 ? "" : "s"}{" "}
              could not be updated:
            </p>
            <ul>
              {failures.map((failure) => (
                <li key={failure}>{failure}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <footer className="set-folder-date-footer">
        <button
          type="button"
          className="secondary-button"
          onClick={onClose}
          disabled={isSubmitting}
        >
          Cancel
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => void handleApply()}
          disabled={isSubmitting || isChecking || !location}
        >
          {isSubmitting
            ? "Setting location…"
            : isChecking
              ? "Checking…"
              : replaceCount !== null
                ? `Replace ${replaceCount} and Apply`
                : "Set Location"}
        </button>
      </footer>
    </dialog>
  );
};

export const SetLocationModal = ({
  isOpen,
  ...props
}: SetLocationModalProps) =>
  isOpen ? <SetLocationDialogContent {...props} /> : null;
