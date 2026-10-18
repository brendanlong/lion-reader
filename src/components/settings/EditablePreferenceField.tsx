/**
 * EditablePreferenceField Component
 *
 * A stored setting shown as its current value with Change/Reset buttons, which
 * turns into an input with Save/Cancel while editing. The draft lives here;
 * saving and resetting are the caller's (usually `usePreferenceMutation`).
 */

"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

export interface EditablePreferenceInputProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  /** A validation error for the draft, to show at the input. */
  error: string | undefined;
}

interface EditablePreferenceFieldProps {
  /** The input's id; the label points at it. */
  id: string;
  label: ReactNode;
  /** Help text under the field. */
  hint?: ReactNode;
  /** The current value, shown when not editing; null shows only the edit button. */
  status: ReactNode | null;
  editLabel: string;
  /** The draft editing starts from. */
  initialDraft: string;
  /** Returns an error to show instead of saving, or null when the draft is valid. */
  validate?: (draft: string) => string | null;
  /** Saves the draft; resolves to whether it succeeded, which ends editing. */
  onSave: (draft: string) => Promise<boolean>;
  /** Clears the stored value; omit when there's nothing to clear. */
  reset?: { label: string; onReset: () => void };
  isPending: boolean;
  renderInput: (props: EditablePreferenceInputProps) => ReactNode;
}

export function EditablePreferenceField({
  id,
  label,
  hint,
  status,
  editLabel,
  initialDraft,
  validate,
  onSave,
  reset,
  isPending,
  renderInput,
}: EditablePreferenceFieldProps) {
  // `draft !== null` *is* the editing state.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startEditing = () => {
    setDraft(initialDraft);
    setError(null);
  };

  const save = async (value: string) => {
    const validationError = validate?.(value) ?? null;
    setError(validationError);
    if (validationError) return;
    if (await onSave(value)) setDraft(null);
  };

  return (
    <div>
      <label htmlFor={id} className="ui-text-sm text-body mb-1.5 block font-medium">
        {label}
      </label>
      {draft !== null ? (
        <div className="space-y-3">
          {renderInput({
            id,
            value: draft,
            onChange: (value) => {
              setDraft(value);
              setError(null);
            },
            disabled: isPending,
            error: error ?? undefined,
          })}
          <div className="flex gap-2">
            <Button onClick={() => save(draft)} loading={isPending} disabled={!draft.trim()}>
              Save
            </Button>
            <Button variant="secondary" onClick={() => setDraft(null)} disabled={isPending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          {status}
          <Button variant="secondary" size="sm" onClick={startEditing}>
            {editLabel}
          </Button>
          {reset && (
            <Button variant="secondary" size="sm" onClick={reset.onReset} loading={isPending}>
              {reset.label}
            </Button>
          )}
        </div>
      )}
      {hint && <p className="ui-text-xs text-muted mt-1.5">{hint}</p>}
    </div>
  );
}
