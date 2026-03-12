# BBit Reader — EEG Meditation Tracker

## What this tool does

BBit Reader is a real-time EEG neurofeedback app built around a simple challenge: sit still for two minutes and try to reach the deepest calm you can. Your brainwaves are read live from a BrainBit headset, processed into a 0–100 meditation score, and reflected back to you through an animated mandala in the browser — the calmer you are, the more it blooms. After the session ends, your score is recorded so you can compare runs and see whether your practice is improving over time.

Under the hood, the app calibrates a personal EEG baseline for each user, computes four neurofeedback metrics (EI, SC, DR, HB) from the live spectrum, and logs every second of data to a CSV file. A terminal dashboard runs alongside the browser visualizer for those who want to watch the raw signal and band power in detail.

## Main capabilities

- Real-time EEG signal acquisition via BrainFlow (BrainBit native or BLED Bluetooth)
- Live FFT-based band power estimation (Delta, Theta, Alpha, Beta, Gamma)
- Personal baseline calibration (60-second open/closed eyes protocol)
- Four meditation quality metrics: EI (Engagement Index), SC (SMR Coherence), DR (Drift Ratio), HB (High Beta)
- Composite meditation score (0–100) with smoothing and trend tracking
- Terminal UI with spectrum visualizer, band history bars, and sensor contact status
- Browser dashboard served at `http://localhost:8080/inner_odyssey.html` via SSE
- Session recording with per-row CSV logging (Player ID + Game ID per session)
- Electrode contact detection — freezes output on signal loss
- Mains notch filter (50 or 60 Hz configurable)

## Typical use cases

- Personal meditation practice with objective brainwave feedback
- Research or classroom demos of EEG neurofeedback
- Comparing meditation quality across sessions using exported CSV logs
- Group settings where multiple participants log results under separate Player/Game IDs
- Exploring how breathing, focus, and relaxation techniques affect EEG metrics in real time

## Installation

Requires **Node.js 18+** and a **BrainBit EEG headset**.

```bash
# Clone the repository
git clone https://github.com/PieterT-CODES/EEG_meditation_app.git
cd EEG_meditation_app

# Install dependencies
npm install
```

BrainFlow is installed automatically as an npm dependency. No separate SDK installation is needed.

## Quick start

```bash
npm start
```

After the device connects (up to 15 seconds):

1. Press **C** to begin calibration (60 seconds — sit calmly, eyes open then closed)
2. When calibration completes, open your browser at:
   ```
   http://localhost:8080/inner_odyssey.html
   ```
3. Enter your name and click **Start** to begin a 2-minute scored session
4. Press **Q** to quit; results are saved automatically to a `.log` file

## Configuration

Edit `config.json` in the project root before starting:

| Key | Default | Description |
|-----|---------|-------------|
| `mode` | `"native"` | `"native"` for BrainBit BLE, `"bled"` for BLED dongle |
| `serial` | `""` | BrainBit serial number (leave empty to auto-connect) |
| `bled_port` | `"COM4"` | Serial port for BLED dongle (Windows: `COM4`, Linux: `/dev/ttyUSB0`) |
| `mains` | `50` | Mains frequency for notch filter — use `60` for North America |
| `channel_index` | `0` | EEG channel index to use (0–3) |
| `refresh_ms` | `180` | UI refresh interval in milliseconds |
| `calibration_seconds` | `60` | Total calibration duration in seconds |
| `channel_labels` | `["T3","T4","O1","O2"]` | Labels for the four EEG electrodes |
| `top_bar_width` | `36` | Width of bar charts in terminal columns |

**Example — BLED dongle on Linux:**
```json
{
  "mode": "bled",
  "bled_port": "/dev/ttyUSB0",
  "mains": 50
}
```

## Output

**Terminal dashboard** shows:

- Live spectrum (1–45 Hz stacked bar)
- Per-band relative and absolute power with scrolling history
- Composite score (0–100) with color indicator: green ≥ 65, orange ≥ 45, red < 45
- Sensor voltage and contact quality per electrode
- Session timer and calibration progress

**Browser visualizer** (`inner_odyssey.html`) receives live data via Server-Sent Events on port 8080 and renders an animated mandala that responds to the meditation score.

**Log files** are written to the project directory as `G<game_id>-P<player_id>.log`:

```
time_ms,delta,theta,alpha,beta,gamma,absDelta,...,EI,SC,DR,HB,score,no_contact
1820,0.312,0.198,...
...
final_score,72.441
```

Each row is one second of data. `no_contact=1` marks samples where electrode contact was lost. The last line contains the session average score.

## EEG Metrics Reference

After calibration completes, the right panel of the terminal displays four live metrics. The same values are streamed to the browser visualizer. All four are shown whenever you are not actively measuring.

**EI — Engagement Index**
Formula: `beta (12–20 Hz) / (alpha + theta)`
Higher EI indicates active attention or focus. Lower EI indicates relaxation or drowsiness.

**SC — SMR / High Beta (calm focus)**
Formula: `SMR (12–15 Hz) / high beta (20–30 Hz)`
Higher SC indicates calm, stable attention without tension. Lower SC suggests nervousness or muscle artifacts.

**DR — Drowsiness Ratio**
Formula: `theta / alpha`
Higher DR indicates drowsiness or dreaminess. Low DR means alertness.

**HB — High Beta Power**
Direct power in the `20–30 Hz` range. Elevated HB often reflects muscle tension or stress and also serves as an artifact indicator.

During a session the score weights these metrics as: `score = 0.45×EI + 0.25×SC − 0.20×DR − 0.10×HB`, normalized to 0–100 around your personal baseline.

## Meditation Game — EEG Aura Mandala

The browser visualizer (`inner_odyssey.html`) is a 2-minute scored meditation game. The animated mandala responds in real time to your EEG score — calm focus makes it expand and stabilize; stress or distraction breaks it apart.

**How to play:**
1. Start the app and calibrate (press **C**, wait ~60 seconds)
2. Open `http://localhost:8080/inner_odyssey.html` in your browser
3. Enter your name and click **Start**
4. After 2 minutes your session score is evaluated and recorded in the results table

**5 techniques for a higher score:**

1. **Breathe slowly and deliberately** — extend your exhale to reduce heart rate and beta activity
2. **Relax your face and forehead muscles** — reduces HB, which is often caused by facial muscle tension
3. **Fix your attention on a single point** — a visual anchor or internal image stabilizes the SMR rhythm
4. **Observe thoughts without engaging them** — letting them pass without judgment balances theta/alpha activity
5. **Cultivate a feeling of gratitude or calm** — emotional states influence EEG immediately and reduce stress beta

**3 things that disrupt meditation:**

1. **Muscle tension (forehead, eyes, jaw)** — raises HB and collapses the mandala
2. **Irregular breathing or breath-holding** — triggers a stress response and pushes the score down
3. **Distraction (phone, noise, wandering thoughts)** — activates beta waves and causes the score to rise

## Limitations

- Requires a BrainBit headset — no support for other EEG devices without modifying the BrainFlow board ID
- Calibration must be repeated each session; baseline is not saved between runs
- Terminal UI requires a minimum width of approximately 80 columns; very narrow terminals will misalign borders
- Browser visualizer requires a modern browser with `EventSource` support (all current browsers)
- Session length defaults to 5 minutes; shorter sessions may produce less stable scores
- Node.js 18 or higher is required; older versions are not supported by the BrainFlow npm package

## Troubleshooting

**Device connect failed / NO DATA on startup**
- Ensure the headset is charged and powered on before running `npm start`
- Check that no other application (e.g. BrainBit app) is connected to the headset
- For BLED mode, verify `bled_port` matches your dongle's port (`Device Manager` on Windows, `ls /dev/tty*` on Linux)

**Score stays at 0 after calibration**
- Recheck electrode contact — the status bar should show green, not red or orange
- Redo calibration with the headset firmly seated; movement artifacts during calibration skew the baseline

**Browser shows blank page at localhost:8080**
- Make sure `npm start` is still running — the server exits if the Node process stops
- Try refreshing after calibration is complete

**Terminal borders look broken**
- Your terminal must support Unicode box-drawing characters and ANSI color codes
- On Windows, use Windows Terminal or PowerShell 7+; avoid the legacy `cmd.exe` console

**`npm install` fails with BrainFlow errors**
- Ensure you are running Node.js 18 or higher: `node --version`
- On Linux, you may need `libudev-dev`: `sudo apt install libudev-dev`

## Support

If this project helped you:

[![Support](https://img.shields.io/badge/☕_buy_me_dinner-support-black?style=for-the-badge)](https://ko-fi.com/pietertcodes)

## License

MIT License — see LICENSE for details.

## Author

Developed by [PieterT-CODES](https://github.com/PieterT-CODES).
