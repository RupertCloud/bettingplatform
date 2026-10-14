import RgControls from './RgControls';

export const metadata = {
  title: 'Responsible gambling',
  description: 'Set deposit, stake and loss limits, take a time-out or exclude yourself from betting.',
};

export default function ResponsibleGamblingPage() {
  return (
    <>
      <h1 className="page-title">Responsible gambling</h1>
      <div className="card">
        <p>
          Betting should be fun. Only bet what you can afford to lose, never chase losses, and take breaks. Betting is for
          people aged 18 and over.
        </p>
        <p className="small muted">If betting stops being fun, set limits below, take a time-out or exclude yourself.</p>
      </div>
      <RgControls />
    </>
  );
}
