import { useEffect, useRef, useState } from "react";
import TagInput from "./TagInput";
import "./SetFolderDateModal.css";

type AddTagsModalProps = {
  isOpen: boolean;
  selectedCount: number;
  suggestions: string[];
  lookupError: string;
  isSubmitting: boolean;
  /** Per-image failures from the last attempt, listed so they can be retried. */
  failures: string[];
  onConfirm: (tags: string[]) => void;
  onClose: () => void;
};

const AddTagsDialogContent = ({
  selectedCount,
  suggestions,
  lookupError,
  isSubmitting,
  failures,
  onConfirm,
  onClose,
}: Omit<AddTagsModalProps, "isOpen">) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [tags, setTags] = useState<string[]>([]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  const addTag = (tag: string) =>
    setTags((current) =>
      current.some(
        (item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase(),
      )
        ? current
        : [...current, tag],
    );

  return (
    <dialog
      ref={dialogRef}
      className="set-folder-date-dialog add-tags-dialog"
      aria-labelledby="add-tags-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!isSubmitting) {
          onClose();
        }
      }}
    >
      <header className="set-folder-date-header">
        <h2 id="add-tags-title">Add Tags to Selected</h2>
        <p className="set-folder-date-subtitle">
          Add tags to the {selectedCount} selected photo group
          {selectedCount === 1 ? "" : "s"}. Existing tags are kept.
        </p>
      </header>

      <div className="set-folder-date-body">
        <label htmlFor="add-tags-input">Tags</label>
        <TagInput
          id="add-tags-input"
          suggestions={suggestions}
          selectedTags={tags}
          onAdd={addTag}
          disabled={isSubmitting}
          lookupError={lookupError}
        />
        {tags.length ? (
          <div className="selected-tags" aria-label="Tags to add">
            {tags.map((tag) => (
              <button
                key={tag.toLocaleLowerCase()}
                type="button"
                onClick={() =>
                  setTags((current) => current.filter((item) => item !== tag))
                }
                disabled={isSubmitting}
                aria-label={`Remove ${tag}`}
              >
                {tag} <span aria-hidden="true">&times;</span>
              </button>
            ))}
          </div>
        ) : null}

        {failures.length ? (
          <div role="alert" className="set-folder-date-error">
            <p>
              {failures.length} photo group{failures.length === 1 ? "" : "s"}{" "}
              could not be tagged:
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
          onClick={() => onConfirm(tags)}
          disabled={isSubmitting || !tags.length}
        >
          {isSubmitting ? "Adding tags…" : "Add Tags"}
        </button>
      </footer>
    </dialog>
  );
};

export const AddTagsModal = ({ isOpen, ...props }: AddTagsModalProps) =>
  isOpen ? <AddTagsDialogContent {...props} /> : null;
