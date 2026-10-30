import { useId, useState, type Ref } from "react";
import { buildTagOptions } from "./tagSuggestions";
import "./TagInput.css";

type TagInputProps = {
  id: string;
  /** Known tags (Immich first, then recent sidecar tags), as full paths. */
  suggestions: string[];
  /** Tags already chosen; they are not offered again. */
  selectedTags: string[];
  onAdd: (tag: string) => void;
  disabled: boolean;
  placeholder?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Shown (and announced) when the Immich tag lookup failed; entry still works. */
  lookupError?: string;
};

/**
 * Tag entry with typeahead (ARIA combobox/listbox). Enter adds the highlighted suggestion, or the typed text as
 * a new tag; "," adds the typed text; Escape closes the list. Typed text that matches no known tag is marked new.
 */
function TagInput({
  id,
  suggestions,
  selectedTags,
  onAdd,
  disabled,
  placeholder = "Type a tag",
  inputRef,
  lookupError,
}: TagInputProps) {
  const generatedId = useId();
  const listboxId = `${generatedId}-listbox`;
  const errorId = `${generatedId}-error`;
  const [text, setText] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const options = buildTagOptions(suggestions, text, selectedTags);
  const showList = isOpen && options.length > 0;

  const add = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed) {
      return;
    }
    onAdd(trimmed);
    setText("");
    setActiveIndex(-1);
  };

  return (
    <div className="tag-input">
      <div className="tag-entry">
        <input
          id={id}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            showList && activeIndex >= 0
              ? `${generatedId}-option-${activeIndex}`
              : undefined
          }
          aria-describedby={lookupError ? errorId : undefined}
          autoComplete="off"
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => {
            setText(event.target.value);
            setActiveIndex(-1);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onBlur={() => setIsOpen(false)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!options.length) {
                return;
              }
              setIsOpen(true);
              const step = event.key === "ArrowDown" ? 1 : -1;
              // Slot 0 means "no suggestion highlighted", so Enter still adds the typed text.
              const slots = options.length + 1;
              setActiveIndex(
                (index) => ((index + 1 + step + slots) % slots) - 1,
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              const active = showList ? options[activeIndex] : undefined;
              add(active ? active.tag : text);
            } else if (event.key === "," && text.trim()) {
              event.preventDefault();
              add(text);
            } else if (event.key === "Escape" && isOpen) {
              event.preventDefault();
              setIsOpen(false);
            }
          }}
        />
        <button
          type="button"
          className="secondary-button"
          onClick={() => add(text)}
          disabled={!text.trim() || disabled}
        >
          Add
        </button>
      </div>
      {showList ? (
        <ul id={listboxId} role="listbox" aria-label="Tag suggestions">
          {options.map((option, index) => (
            <li
              key={`${option.isNew ? "new" : "known"}-${option.tag}`}
              id={`${generatedId}-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "active" : undefined}
              // mousedown keeps focus in the input so blur does not close the list before the click lands.
              onMouseDown={(event) => {
                event.preventDefault();
                add(option.tag);
              }}
            >
              {option.isNew ? (
                <>
                  {option.tag}
                  <span className="tag-input-new">New tag</span>
                </>
              ) : (
                option.tag
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {lookupError ? (
        <p id={errorId} role="alert" className="tag-input-error">
          {lookupError} Showing recent tags only; you can still type new tags.
        </p>
      ) : null}
    </div>
  );
}

export default TagInput;
