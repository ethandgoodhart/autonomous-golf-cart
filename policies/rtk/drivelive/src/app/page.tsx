import fs from 'fs';
import path from 'path';
import DriveApp from '@/components/DriveApp';

export const dynamic = 'force-dynamic';

export default function Page() {
  const annotationsPath = path.join(process.cwd(), '..', 'annotations.json');
  const raw = JSON.parse(fs.readFileSync(annotationsPath, 'utf-8'));
  return <DriveApp rawAnnotations={raw} />;
}
