/** Every page change: the new page slides in softly (app/globals.css .page-in). */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-in">{children}</div>;
}
