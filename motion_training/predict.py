"""Offline inference using exactly the training feature pipeline."""
import argparse
import csv
from pathlib import Path
import joblib
import numpy as np
from features import load_windows


def main():
    parser = argparse.ArgumentParser(description="用训练好的模型识别 CSV 中的动作")
    parser.add_argument("--model", required=True)
    parser.add_argument("--input", nargs="+", required=True)
    parser.add_argument("--output", default="predictions.csv")
    parser.add_argument("--threshold", type=float, default=0.6, help="低于阈值输出 UNKNOWN，需按验证数据调整")
    args = parser.parse_args()
    if not 0 <= args.threshold <= 1:
        parser.error("threshold 必须在 0 和 1 之间。")
    bundle = joblib.load(args.model)
    metadata, model = bundle["metadata"], bundle["model"]
    try:
        windows, _ = load_windows(args.input, metadata["sample_rate_hz"], metadata["window_seconds"], metadata["stride_seconds"], require_labels=False)
    except ValueError as error:
        parser.exit(2, f"数据错误：{error}\n")
    probabilities = model.predict_proba(np.stack([w.features for w in windows]))
    output = Path(args.output); output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream); writer.writerow(["session_id", "window_start_ms", "candidate", "prediction", "confidence"])
        for window, scores in zip(windows, probabilities):
            index = int(np.argmax(scores)); candidate = model.classes_[index]; confidence = float(scores[index])
            writer.writerow([window.session, window.start_ms, candidate, candidate if confidence >= args.threshold else "UNKNOWN", round(confidence, 4)])
    print(f"已识别 {len(windows)} 个窗口：{output.resolve()}")


if __name__ == "__main__":
    main()
