import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DriveLive - Self-Driving Golf Cart',
  description: 'Live GPS tracking and route navigation for Stanford campus',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-black">{children}</body>
    </html>
  );
}
