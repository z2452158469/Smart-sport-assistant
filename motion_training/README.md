# 合加速度动作识别训练

在电脑上训练随机森林，只使用时间戳与合加速度波形。模型不需要部署到 ESP32。配套 dashboard 支持 USB 串口采集、标注与 CSV 导出，并使用本地 Python 服务实时推理，将结果回传 ESP32。

## 安装

在本目录打开终端，建议使用 Python 3.11 或更新版本：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## 准备数据

CSV 必须包含 `timestamp_ms,accel_magnitude,label`，可使用 `data/template.csv` 的表头。合加速度单位统一为 **m/s²**，包含重力，来自校准后的 `sqrt(ax²+ay²+az²)`；不要把 g 和 m/s² 混用。

```csv
timestamp_ms,accel_magnitude,label,session_id,person_id
0,9.81,IDLE,idle_01,p01
20,9.85,IDLE,idle_01,p01
40,9.78,IDLE,idle_01,p01
```

上面三行仅解释格式，不足以训练。建议标签为 `JUMPING_JACK`（开合跳）、`SQUAT`（蹲起）、`RUNNING`（跑步）、`IDLE`（静止）、`OTHER`（其他动作）。中文标签也可以，但整个数据集命名必须一致。

- 固定佩戴位置，每类先采集多段 20～60 秒数据，覆盖不同动作速度。
- 默认使用 50Hz，即每 20ms 一条。使用更新后的 SmartSportBLE 固件和 dashboard 的 USB 串口采集模式导出完整数据；低频蓝牙查看数据不适合直接训练。
- 每次独立录制使用不同的 `session_id`；同一场次时间必须严格递增。新场次可以从 0 开始。
- `session_id` 未填写时，一个 CSV 文件视为一个场次。因此最简单的组织方式是每次录制保存单独 CSV，每个类别至少有两次独立录制，建议更多。
- 同一场次即便分多个文件也使用同一个 ID，确保不会拆进训练集和测试集。不同人填写不同 `person_id`。
- 文件夹可按动作分类，但程序以 `label` 列为准，不从文件夹名猜测标签。
- 时间戳仅用于重采样和切窗，不是分类特征。标注变化或超过 100ms 的断点不会跨越切窗；缺失的短间隔只做轻微插值。
- 输入目录只放原始采集 CSV，结果输出目录放在外面，避免下一次将报告当成训练数据读入。

## 训练

本次电脑已在 `.deps` 安装依赖。在本目录终端可以直接运行：

```powershell
.\train.cmd --input data --output models
```

换电脑时按上面的虚拟环境步骤安装，再使用以下命令：

```powershell
.\.venv\Scripts\python.exe train.py --input data --output models
```

默认：50Hz、2 秒窗口、0.5 秒步长、200 棵树、最大深度 12。特征包括均值、标准差、最小/最大值、极差、RMS、平均相邻变化、峰值数量、主频及主频功率占比。

程序按**录制场次**先划分独立训练/测试集合，窗口不跨场次，同一场次的重叠窗口不会分到两侧。测试集合必须包含全部类别，不满足时会报出采集建议，不会退回随机窗口划分。一次测试不应反复用于调参；若需要调参，应另留独立最终测试数据。

如果希望验证对新用户的识别效果，填好 person_id 并按人员划分：

```powershell
.\.venv\Scripts\python.exe train.py --input data --output models --group-by person
```

输出：

| 文件 | 内容 |
|---|---|
| `motion_model.joblib` | 模型、特征顺序、采样与窗口配置、依赖版本 |
| `metrics.json` | 准确率、各类 precision/recall/F1、场次划分、特征重要性 |
| `confusion_matrix.csv` | 混淆矩阵，行是真实动作、列是预测动作 |
| `window_features.csv` | 每个窗口的特征、标签、训练/测试归属 |

保存的是完成测试的模型，没有偷偷使用测试数据重新训练。精度取决于真实数据，合加速度可能难以区分节奏相近的跑步与开合跳。

## 识别新的 CSV

新数据可以省略 label，但必须提供时间戳与合加速度：

```powershell
.\.venv\Scripts\python.exe predict.py --model models/motion_model.joblib --input new_data.csv --output predictions.csv
```

默认最大类别概率低于 0.6 时输出 `UNKNOWN`。这是可调整的初始阈值，不是经过概率校准的可靠性保证。

模型使用 joblib 保存，仅加载自己训练或可信来源的模型；训练与加载建议保持相同依赖版本。[scikit-learn 模型保存说明](https://scikit-learn.org/stable/model_persistence.html)
