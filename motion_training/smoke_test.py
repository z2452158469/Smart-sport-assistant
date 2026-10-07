"""Synthetic integration check only; not evidence of real activity accuracy."""
import csv
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import numpy as np
from features import extract_features, load_windows


def main():
    root = Path(__file__).resolve().parent
    # A flat 1g trace has no dominant motion frequency or prominent peaks.
    flat = extract_features(np.full(100, 9.80665), 50)
    assert abs(flat[1]) < 1e-8 and flat[7] == 0 and flat[8] == 0
    with tempfile.TemporaryDirectory(prefix="motion-smoke-", dir=root) as temporary:
        folder = Path(temporary); data = folder / "data"; data.mkdir()
        for label, frequency, amplitude in [("IDLE", 0, 0), ("SQUAT", 0.5, 1), ("RUNNING", 3, 3), ("JUMPING_JACK", 1.5, 5)]:
            for session in range(4):
                rng = np.random.default_rng(session + round(frequency * 10))
                with (data / f"{label}_{session}.csv").open("w", encoding="utf-8", newline="") as stream:
                    writer = csv.writer(stream); writer.writerow(["timestamp_ms", "accel_magnitude", "label", "session_id"])
                    for sample in range(1000):
                        time = sample * 20
                        value = 9.80665 + amplitude * np.sin(2 * np.pi * frequency * time / 1000) + rng.normal(0, 0.03)
                        writer.writerow([time, value, label, f"{label}_{session}"])
        output = folder / "results"
        subprocess.run([sys.executable, str(root / "train.py"), "--input", str(data), "--output", str(output)], check=True)
        metrics = json.loads((output / "metrics.json").read_text(encoding="utf-8"))
        assert not set(metrics["train_groups"]) & set(metrics["test_groups"])
        assert metrics["train_windows"] > 0 and metrics["test_windows"] > 0
        predictions = folder / "predictions.csv"
        subprocess.run([sys.executable, str(root / "predict.py"), "--model", str(output / "motion_model.joblib"), "--input", str(data / "RUNNING_0.csv"), "--output", str(predictions)], check=True)
        assert len(list(csv.DictReader(predictions.open(encoding="utf-8-sig")))) > 0
        # Label transitions must not produce mixed-label windows.
        transition = folder / "transition.csv"
        with transition.open("w", newline="") as stream:
            writer = csv.writer(stream); writer.writerow(["timestamp_ms", "accel_magnitude", "label"])
            for index in range(150):
                writer.writerow([index * 20, 9.8, "A" if index < 75 else "B"])
        try:
            load_windows([transition])
        except ValueError:
            pass
        else:
            raise AssertionError("Mixed-label windows must not cross transitions")
        # Do not silently interpolate dashboard 5Hz recordings into 50Hz training.
        sparse = folder / "sparse.csv"
        with sparse.open("w", newline="") as stream:
            writer = csv.writer(stream); writer.writerow(["timestamp_ms", "accel_magnitude", "label"])
            for index in range(30):
                writer.writerow([index * 200, 9.8, "IDLE"])
        try:
            load_windows([sparse])
        except ValueError:
            pass
        else:
            raise AssertionError("Sparse sampling must be rejected")
    print("PASS: synthetic training, saved-model inference, session separation and input validation")


if __name__ == "__main__":
    main()
