import { Outlet, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { Toaster } from "@/components/ui/sonner";

// Minimal app shell — provides only the layout frame: it owns the single
// `min-h-screen`, mounts the <Toaster/>, and plays a subtle entrance on each
// route. It deliberately ships NO navigation chrome. Decide per app what fits:
//   • a top navbar  → add a sticky <header> above <main> with <Link>s,
//   • a sidebar     → replace <main> with `SidebarInset`; never render both,
//   • or nothing    → single-screen / focused apps often need no nav at all.
// When you add nav, map over `routes` from `@/routes` so route + nav stay in sync.
// Pages fill <main flex-1> with `h-full`; never add `min-h-screen` inside a page.
// Brand mark: a failure chain — effect, failure mode, cause — drawn as three
// linked nodes, the core object of a DFMEA.
function BrandMark() {
  return (
    <svg viewBox="0 0 28 28" className="size-7 shrink-0" aria-hidden="true">
      <rect width="28" height="28" rx="6" className="fill-primary" />
      <path d="M8 14h12M20 14l0-6M20 14l0 6" className="stroke-primary-foreground" strokeWidth="1.6" fill="none" />
      <circle cx="7" cy="14" r="2.6" className="fill-primary-foreground" />
      <rect x="11.4" y="11.4" width="5.2" height="5.2" rx="1" className="fill-primary-foreground" />
      <circle cx="21" cy="8" r="2" className="fill-primary-foreground" />
      <circle cx="21" cy="20" r="2" className="fill-primary-foreground" />
    </svg>
  );
}

export function AppShell() {
  const { pathname } = useLocation();
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#failure-network"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-md focus:outline-2 focus:outline-ring"
      >
        Skip to failure network
      </a>
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2.5 border-b bg-background px-4 lg:px-6">
        <BrandMark />
        <span className="text-sm font-semibold tracking-tight">DFMEA Workshop Studio</span>
      </header>
      <main className="flex flex-1 flex-col">
        {/* key on pathname → each route re-mounts and replays the entrance.
            Entrance-only (no AnimatePresence/exit): an exit animation around
            <Outlet/> would animate the NEXT route's content, not the leaving one. */}
        <motion.div
          key={pathname}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="flex-1"
        >
          <Outlet />
        </motion.div>
      </main>
      <Toaster />
    </div>
  );
}

export default AppShell;
