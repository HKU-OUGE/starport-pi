import { Converter } from "opencc-js/cn2t";
const traditional = Converter({ from: "cn", to: "tw" });
// Keep executable/verbatim spans and resource addresses byte-for-byte intact.
export function toTraditional(text) {
  return text
    .split(
      /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|https?:\/\/[^\s<>]+|\b[A-Za-z]:[\\/][^\s]+|(?:\/|\.\/|\.\.\/)(?:[^\s/]+\/)+[^\s]*)/g,
    )
    .map((s, i) => (i % 2 ? s : traditional(s)))
    .join("");
}
