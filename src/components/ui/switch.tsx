/**
 * Switch Component
 *
 * An on/off toggle (`role="switch"`) for settings. Label it with the id of the
 * visible text that names it.
 */

interface SwitchProps {
  checked: boolean;
  onChange: () => void;
  /** Id of the element whose text labels the switch. */
  labelledBy: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, labelledBy, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-primary-solid" : "bg-fill-muted"
      }`}
    >
      <span
        aria-hidden="true"
        className={`bg-surface pointer-events-none inline-block h-5 w-5 transform rounded-full shadow ring-0 transition duration-200 ease-in-out ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}
