/**
 * Official full-color icons, generated into src/assets/brands by scripts/brand-icons.mjs
 * (Iconify "logos" SVGs, or the icon each vendor publishes). Brands without one get a letter mark.
 */
const ICONS = import.meta.glob("../assets/brands/*.{svg,png,ico,webp,jpg}", { eager: true, import: "default", query: "?url" }) as Record<string, string>;

const BY_ID = new Map(
  Object.entries(ICONS).map(([file, url]) => [file.split("/").pop()!.replace(/\.[^.]+$/, ""), url]),
);

export function BrandIcon(props: { id: string; name: string; size?: number }) {
  const size = props.size ?? 26;
  const url = BY_ID.get(props.id);
  if (url) return <img className="brand-icon" src={url} alt="" width={size} height={size} draggable={false} />;
  return (
    <span className="brand-icon letter" style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }} aria-hidden="true">
      {props.name.charAt(0)}
    </span>
  );
}
