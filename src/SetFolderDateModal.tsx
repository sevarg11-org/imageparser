import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { completeDateSegment, toIsoDate, type DateSegments } from "./dateEntry";
import "./SetFolderDateModal.css";

type SetFolderDateModalProps = {
  isOpen: boolean;
  totalCount: number;
  /** The number of folders covered in nested mode, or null when only the loaded folder is covered. */
  nestedFolderCount: number | null;
  /** The number of chosen groups when dating a selection instead of the folder. */
  selectedCount?: number;
  onConfirm: (date: string) => void;
  onClose: () => void;
  isSubmitting?: boolean;
};

const SetFolderDateDialogContent = ({
  totalCount,
  nestedFolderCount,
  selectedCount,
  onConfirm,
  onClose,
  isSubmitting,
}: Omit<SetFolderDateModalProps, "isOpen">) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const monthInputRef = useRef<HTMLInputElement>(null);
  const dayInputRef = useRef<HTMLInputElement>(null);
  const yearInputRef = useRef<HTMLInputElement>(null);

  const [dateSegments, setDateSegments] = useState<DateSegments>({
    month: "",
    day: "",
    year: "",
  });
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    const timer = window.setTimeout(() => {
      monthInputRef.current?.focus();
    }, 50);
    return () => window.clearTimeout(timer);
  }, []);

  const handleDateSegmentChange = (
    field: keyof DateSegments,
    value: string,
  ) => {
    const digits = value.replace(/\D/g, "").slice(0, field === "year" ? 4 : 2);
    const next = { ...dateSegments, [field]: digits };
    setDateSegments(next);
    setErrorMessage("");

    const segmentNumber = Number(digits);
    const isMonthComplete =
      digits.length === 2
        ? segmentNumber >= 1 && segmentNumber <= 12
        : segmentNumber >= 2;
    const isDayComplete =
      digits.length === 2
        ? segmentNumber >= 1 && segmentNumber <= 31
        : segmentNumber >= 4;

    if (field === "month" && digits && isMonthComplete) {
      dayInputRef.current?.focus();
    } else if (field === "day" && digits && isDayComplete) {
      yearInputRef.current?.focus();
    }
  };

  const handleDateSegmentBlur = (field: keyof DateSegments) => {
    setDateSegments((current) => ({
      ...current,
      [field]: completeDateSegment(current[field], field),
    }));
  };

  const handleSubmit = () => {
    const completedSegments: DateSegments = {
      month: completeDateSegment(dateSegments.month, "month"),
      day: completeDateSegment(dateSegments.day, "day"),
      year: completeDateSegment(dateSegments.year, "year"),
    };
    setDateSegments(completedSegments);

    const isoDate = toIsoDate(completedSegments);
    if (!isoDate) {
      setErrorMessage("Enter a valid month, day, and year.");
      return;
    }

    onConfirm(isoDate);
  };

  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleSubmit();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="set-folder-date-dialog"
      aria-labelledby="set-folder-date-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!isSubmitting) {
          onClose();
        }
      }}
      onKeyDown={handleKeyDown}
    >
      <header className="set-folder-date-header">
        <h2 id="set-folder-date-title">
          {selectedCount === undefined
            ? "Set Date for Folder"
            : "Set Date for Selected"}
        </h2>
        <p className="set-folder-date-subtitle">
          {selectedCount !== undefined
            ? `Apply a date to the ${selectedCount} selected photo group${selectedCount === 1 ? "" : "s"}, replacing any date already saved for them.`
            : nestedFolderCount === null
              ? "Apply a date to all images in this folder without existing metadata"
              : `Apply a date to all images in this folder and all its nested folders (${nestedFolderCount} folder${nestedFolderCount === 1 ? "" : "s"} in total) without existing metadata`}{" "}
          {selectedCount === undefined
            ? ` (${totalCount} total photo group${totalCount === 1 ? "" : "s"}).`
            : null}
        </p>
      </header>

      <div className="set-folder-date-body">
        <fieldset className="metadata-date" style={{ margin: "0 auto" }}>
          <legend>Date</legend>
          <div className="date-segments">
            <input
              ref={monthInputRef}
              type="text"
              inputMode="numeric"
              maxLength={2}
              aria-label="Month"
              placeholder="MM"
              value={dateSegments.month}
              onChange={(e) => handleDateSegmentChange("month", e.target.value)}
              onBlur={() => handleDateSegmentBlur("month")}
              disabled={isSubmitting}
            />
            <span aria-hidden="true">/</span>
            <input
              ref={dayInputRef}
              type="text"
              inputMode="numeric"
              maxLength={2}
              aria-label="Day"
              placeholder="DD"
              value={dateSegments.day}
              onChange={(e) => handleDateSegmentChange("day", e.target.value)}
              onBlur={() => handleDateSegmentBlur("day")}
              disabled={isSubmitting}
            />
            <span aria-hidden="true">/</span>
            <input
              ref={yearInputRef}
              type="text"
              inputMode="numeric"
              maxLength={4}
              aria-label="Year"
              placeholder="YYYY"
              value={dateSegments.year}
              onChange={(e) => handleDateSegmentChange("year", e.target.value)}
              onBlur={() => handleDateSegmentBlur("year")}
              disabled={isSubmitting}
            />
          </div>
        </fieldset>

        {errorMessage ? (
          <p role="alert" className="set-folder-date-error">
            {errorMessage}
          </p>
        ) : null}

        <p className="set-folder-date-note">
          {selectedCount === undefined
            ? "Images that already have an XMP sidecar file will be skipped."
            : "Each photo keeps its description and tags. An XMP sidecar file is created for photos without one."}
        </p>
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
          onClick={handleSubmit}
          disabled={isSubmitting}
        >
          {isSubmitting
            ? "Setting date…"
            : selectedCount === undefined
              ? "Set Date for All"
              : "Set Date for Selected"}
        </button>
      </footer>
    </dialog>
  );
};

export const SetFolderDateModal = ({
  isOpen,
  totalCount,
  nestedFolderCount,
  selectedCount,
  onConfirm,
  onClose,
  isSubmitting = false,
}: SetFolderDateModalProps) => {
  if (!isOpen) {
    return null;
  }

  return (
    <SetFolderDateDialogContent
      totalCount={totalCount}
      nestedFolderCount={nestedFolderCount}
      selectedCount={selectedCount}
      onConfirm={onConfirm}
      onClose={onClose}
      isSubmitting={isSubmitting}
    />
  );
};
