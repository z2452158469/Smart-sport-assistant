"""Train a session-separated random forest from labeled motion CSV files."""
import argparse
import csv
import json
import platform
from pathlib import Path
import joblib
import numpy as np
import sklearn
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
from sklearn.model_selection import GroupShuffleSplit
from features import FEATURE_NAMES, load_windows


def main():
    parser = argparse.ArgumentParser(description="时间戳 + 合加速度：随机森林动作分类训练")
    parser.add_argument("--input", nargs="+", required=True, help="训练 CSV 文件或目录")
    parser.add_argument("--output", default="models", help="结果目录")
    parser.add_argument("--sample-rate", type=float, default=50)
    parser.add_argument("--window", type=float, default=2)
    parser.add_argument("--stride", type=float, default=0.5)
    parser.add_argument("--test-size", type=float, default=0.25)
    parser.add_argument("--group-by", choices=["session", "person"], default="session")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    try:
        if not 0 < args.test_size < 1:
            raise ValueError("test-size 必须在 0 和 1 之间。")
        windows, sampling = load_windows(args.input, args.sample_rate, args.window, args.stride)
        x = np.stack([w.features for w in windows])
        y = np.array([w.label for w in windows])
        if args.group_by == "person" and any(not w.person for w in windows):
            raise ValueError("按人员划分需要所有数据都有 person_id。")
        groups = np.array([w.person if args.group_by == "person" else json.dumps([w.person, w.session]) for w in windows])
        labels = sorted(set(y))
        if len(labels) < 2:
            raise ValueError("训练至少需要两个动作类别；建议包含三个目标动作以及静止、其他动作。")
        for label in labels:
            if len(set(groups[y == label])) < 2:
                raise ValueError(f"类别「{label}」至少需要两个独立{ '人员' if args.group_by == 'person' else '录制场次' }，才能在不泄漏数据的情况下划分训练/测试集。")
        # Select by class coverage only; never select a split by test accuracy.
        splitter = GroupShuffleSplit(n_splits=200, test_size=args.test_size, random_state=args.seed)
        split = next(((train, test) for train, test in splitter.split(x, y, groups)
                      if set(y[train]) == set(labels) and set(y[test]) == set(labels)), None)
        if split is None:
            raise ValueError("无法让训练集和测试集都包含所有类别。请增加独立场次，或调整 test-size。")
        train_indices, test_indices = split
        model = RandomForestClassifier(n_estimators=200, max_depth=12, min_samples_leaf=2,
                                       class_weight="balanced", n_jobs=-1, random_state=args.seed)
        model.fit(x[train_indices], y[train_indices])
        predicted = model.predict(x[test_indices])
        report = classification_report(y[test_indices], predicted, labels=labels, output_dict=True, zero_division=0)
        matrix = confusion_matrix(y[test_indices], predicted, labels=labels)
        output = Path(args.output)
        output.mkdir(parents=True, exist_ok=True)
        metadata = {"protocol_version": 1, "sample_rate_hz": args.sample_rate,
                    "window_seconds": args.window, "stride_seconds": args.stride,
                    "acceleration_unit": "m/s^2", "feature_names": FEATURE_NAMES,
                    "classes": labels, "versions": {"python": platform.python_version(),
                    "numpy": np.__version__, "scikit_learn": sklearn.__version__, "joblib": joblib.__version__}}
        # Keep the evaluated model; do not silently refit on the held-out test set.
        joblib.dump({"model": model, "metadata": metadata}, output / "motion_model.joblib")
        metrics = {**metadata, "accuracy": float(accuracy_score(y[test_indices], predicted)),
                   "classification_report": report, "confusion_matrix": matrix.tolist(),
                   "group_by": args.group_by, "seed": args.seed,
                   "train_windows": len(train_indices), "test_windows": len(test_indices),
                   "train_groups": sorted(set(groups[train_indices])), "test_groups": sorted(set(groups[test_indices])),
                   "sampling": sampling, "feature_importances": dict(zip(FEATURE_NAMES, model.feature_importances_.tolist()))}
        (output / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
        with (output / "confusion_matrix.csv").open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.writer(stream); writer.writerow(["真实标签 / 预测标签", *labels])
            writer.writerows([label, *row] for label, row in zip(labels, matrix.tolist()))
        train_set = set(train_indices.tolist())
        with (output / "window_features.csv").open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.writer(stream); writer.writerow(["session_id", "person_id", "start_ms", "label", "split", *FEATURE_NAMES])
            for index, window in enumerate(windows):
                writer.writerow([window.session, window.person, window.start_ms, window.label,
                                 "train" if index in train_set else "test", *window.features.tolist()])
        print(f"训练完成：{len(train_indices)} 个训练窗口，{len(test_indices)} 个独立测试窗口")
        print(classification_report(y[test_indices], predicted, labels=labels, zero_division=0))
        print(f"模型和评估文件：{output.resolve()}")
    except ValueError as error:
        parser.exit(2, f"数据错误：{error}\n")


if __name__ == "__main__":
    main()
