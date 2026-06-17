import AdminTabs from "@/components/admin-tabs";

/**
 * Segment layout for /admin/*. Adds the secondary admin tab strip beneath the
 * global AppNav (which comes from the root layout), yielding the two stacked bars.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AdminTabs />
      {children}
    </>
  );
}
