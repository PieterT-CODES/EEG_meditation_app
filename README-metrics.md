# EEG Metrics Display (Post-Calibration)

After completing calibration, the right panel shows **four live metrics** computed from the EEG spectrum:

1. **EI – Engagement Index**  
   Formula: `beta (12–20 Hz) / (alpha + theta)`  
   ↑ means active attention/focus; ↓ means relaxation/drowsiness.

2. **SC – SMR / High Beta (stability, calm focus)**  
   Formula: `SMR (12–15 Hz) / high beta (20–30 Hz)`  
   ↑ indicates calm, stable attention without tension; ↓ suggests nervousness or muscle artifacts.

3. **DR – Drowsiness Ratio**  
   Formula: `theta / alpha`  
   ↑ indicates drowsiness/dreaminess; low DR means alertness.

4. **HB – High Beta Power**  
   Direct power in `20–30 Hz`. Often relates to muscle tension or stress (useful artifact indicator).

> The four values appear after calibration is done and whenever you are not currently measuring.