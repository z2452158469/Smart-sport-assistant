"""Shared training/inference preprocessing for timestamp + acceleration magnitude."""
import csv
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
import numpy as np

FEATURE_NAMES = ["mean", "std", "min", "max", "range", "rms", "mean_abs_change",
                 "peak_count", "dominant_frequency_hz", "dominant_power_ratio"]


@dataclass
class Window:
    features: np.ndarray
    label: str
    session: str
    person: str
    start_ms: float


def extract_features(values, sample_rate):
    values = np.asarray(values, dtype=float)
    centered = values - values.mean()
    std = float(values.std())
    # Count prominent local maxima, separated by at least 0.2 seconds.
    candidates = np.flatnonzero((values[1:-1] > values[:-2]) &
                                (values[1:-1] >= values[2:]) &
                                (values[1:-1] > values.mean() + 0.5 * std)) + 1
    peaks = []
    for index in sorted(candidates, key=lambda i: values[i], reverse=True):
        if all(abs(index - previous) >= max(1, round(sample_rate * 0.2)) for previous in peaks):
            peaks.append(index)
    power = np.abs(np.fft.rfft(centered * np.hanning(len(values)))) ** 2
    frequencies = np.fft.rfftfreq(len(values), d=1 / sample_rate)
    eligible = (frequencies >= 0.5) & (frequencies <= min(10, sample_rate / 2))
    dominant = ratio = 0.0
    if std > 1e-8 and np.any(eligible) and power[eligible].sum() > 1e-12:
        indices = np.flatnonzero(eligible)
        best = indices[np.argmax(power[eligible])]
        dominant = float(frequencies[best])
        ratio = float(power[best] / power[eligible].sum())
    return np.array([values.mean(), std, values.min(), values.max(), np.ptp(values),
                     np.sqrt(np.mean(values ** 2)), np.mean(np.abs(np.diff(values))),
                     len(peaks), dominant, ratio], dtype=float)


def load_windows(inputs, sample_rate=50, window_seconds=2, stride_seconds=0.5,
                 require_labels=True):
    if sample_rate < 20 or window_seconds <= 0 or stride_seconds <= 0:
        raise ValueError("采样率至少 20Hz，窗口长度和步长必须为正数。")
    size, stride = round(sample_rate * window_seconds), round(sample_rate * stride_seconds)
    if size < 20 or stride < 1:
        raise ValueError("窗口至少需要 20 个采样点，步长至少 1 个采样点。")
    if abs(size / sample_rate - window_seconds) > 1e-6 or abs(stride / sample_rate - stride_seconds) > 1e-6:
        raise ValueError("窗口长度和步长乘以采样率必须是整数。")
    paths = []
    for value in inputs:
        path = Path(value)
        if path.is_dir():
            paths.extend(sorted(path.rglob("*.csv")))
        elif path.is_file():
            paths.append(path)
        else:
            raise ValueError(f"找不到输入路径：{path}")
    paths = list(dict.fromkeys(path.resolve() for path in paths))
    if not paths:
        raise ValueError("没有找到 CSV 数据文件。")
    sessions = defaultdict(list)
    for path in paths:
        with path.open(encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            required = {"timestamp_ms", "accel_magnitude"}
            if require_labels:
                required.add("label")
            if not required.issubset(reader.fieldnames or []):
                raise ValueError(f"{path.name} 缺少列：{', '.join(sorted(required - set(reader.fieldnames or [])))}")
            for line, row in enumerate(reader, 2):
                try:
                    time, magnitude = float(row["timestamp_ms"]), float(row["accel_magnitude"])
                    if not np.isfinite([time, magnitude]).all() or time < 0 or magnitude < 0:
                        raise ValueError()
                except (ValueError, TypeError):
                    raise ValueError(f"{path.name}:{line} 时间或合加速度无效。") from None
                label = (row.get("label") or "").strip()
                if require_labels and not label:
                    raise ValueError(f"{path.name}:{line} 缺少动作标签。")
                person = (row.get("person_id") or "").strip()
                session = (row.get("session_id") or "").strip() or str(path)
                key = (person, session)
                if sessions[key] and time <= sessions[key][-1][0]:
                    raise ValueError(f"{path.name}:{line} 同一场次时间必须严格递增；重新录制或时间复位后请使用新的 session_id。")
                sessions[key].append((time, magnitude, label or "unlabeled"))
    windows, sampling = [], []
    period = 1000 / sample_rate
    for (person, session), rows in sessions.items():
        times = np.array([r[0] for r in rows])
        differences = np.diff(times)
        normal = differences[(differences > 0) & (differences <= period * 5)]
        if not len(normal):
            raise ValueError(f"场次 {session} 数据太少或采样率过低。")
        measured = 1000 / np.median(normal)
        if not 0.85 * sample_rate <= measured <= 1.15 * sample_rate:
            raise ValueError(f"场次 {session} 实际采样率约 {measured:.1f}Hz，与配置 {sample_rate}Hz 不符。请采集完整高频数据，不要将 5Hz 网页数据插值为 50Hz。")
        sampling.append({"session": session, "person": person, "measured_hz": float(measured), "rows": len(rows)})
        # Break at label transitions and long gaps; never bridge them by interpolation.
        boundaries = [0] + [i for i in range(1, len(rows))
                           if rows[i][2] != rows[i-1][2] or times[i] - times[i-1] > period * 5] + [len(rows)]
        for begin, end in zip(boundaries[:-1], boundaries[1:]):
            segment = rows[begin:end]
            if len(segment) < 2:
                continue
            t = np.array([r[0] for r in segment])
            grid = t[0] + np.arange(int(np.floor((t[-1] - t[0]) / period)) + 1) * period
            values = np.interp(grid, t, [r[1] for r in segment])
            for start in range(0, len(values) - size + 1, stride):
                windows.append(Window(extract_features(values[start:start+size], sample_rate),
                                      segment[0][2], session, person, float(grid[start])))
    if not windows:
        raise ValueError("没有足够长的连续数据窗口；请延长每次录制，或检查断点与标签变化。")
    return windows, sampling
