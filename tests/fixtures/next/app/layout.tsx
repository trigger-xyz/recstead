import type { ReactNode } from 'react';

export const metadata = { title: 'Recstead Next.js fixture' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
