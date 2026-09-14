interface NumPadProps {
  value: string;
  onChange: (next: string) => void;
  maxLength?: number;
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"];

export default function NumPad({ value, onChange, maxLength = 4 }: NumPadProps) {
  const press = (key: string) => {
    if (key === "clear") return onChange("");
    if (key === "back") return onChange(value.slice(0, -1));
    if (value.length >= maxLength) return;
    onChange(value + key);
  };

  return (
    <div className="grid grid-cols-3 gap-3">
      {KEYS.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => press(key)}
          className="tile h-20 text-2xl"
        >
          {key === "back" ? "⌫" : key === "clear" ? "C" : key}
        </button>
      ))}
    </div>
  );
}
