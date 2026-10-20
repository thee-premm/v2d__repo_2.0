import type { ReactNode } from "react";
import { Brand } from "../../components/Brand";

const POINTS = ["Students vote before cutoff", "Kitchens prepare to forecast", "Waste is measured, not guessed"];

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <section className="auth-story" aria-label="About Vote2Dine">
        <Brand />
        <div className="auth-intro">
          <h1>
            Plan meals around <em>real</em> demand.
          </h1>
          <p className="auth-lede">Students declare intent, kitchens cook to a forecast, and every meal closes with an honest count.</p>
          <ul className="auth-points">
            {POINTS.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
        <p className="auth-foot">Meal planning for institutional dining</p>
      </section>
      <div className="auth-form-side">
        <div className="auth-card">{children}</div>
      </div>
    </div>
  );
}
