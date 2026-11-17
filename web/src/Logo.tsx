/**
 * Alfred's calendar with a check, from the Postmelo identity kit, in its light and dark variants.
 * Both images are in the page and CSS shows the one for the effective theme (.logo-light / .logo-dark in styles.css).
 */
export function Logo({ big = false }: { big?: boolean }) {
  return (
    <span className={big ? 'logo big' : 'logo'} aria-hidden="true">
      <img className="logo-light" src="/brand/alfred/icon-light-128.png" alt="" width={128} height={128} draggable={false} />
      <img className="logo-dark" src="/brand/alfred/icon-dark-128.png" alt="" width={128} height={128} draggable={false} />
    </span>
  );
}
