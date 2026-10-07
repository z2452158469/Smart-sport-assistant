# 智能运动助手 · 蓝牙实时仪表盘

## 使用步骤

1. 在 Arduino IDE 打开上一级目录的 `SmartSportBLE/SmartSportBLE.ino`，上传到调试成功的 ESP32。原 `SmartSportTest` 程序保留，单独上传原程序不会广播 dashboard 所需的蓝牙服务。
2. 沿用已调试的接线和传感器库。BLE 使用 ESP32 开发板支持包自带的库，无需另装 `ESP32 BLE Arduino`。
3. 用 USB 连接 ESP32，关闭 Arduino 串口监视器。双击 `start-dashboard.cmd` 启动 Python 本地服务，在桌面 Chrome 或 Edge 中打开 `http://localhost:8082/`。
4. 选择 **USB 串口 · 采集与识别**，点击「连接设备」，选择 ESP32 的 COM 端口。该端口由网页统一读写，不能再由其他串口软件占用。蓝牙模式仍能查看原有低频数据，但不能用于训练采集和实时模型识别。
5. 放好手指等待心率稳定，轻转 MPU6050 观察加速度、角速度和曲线。可选择 30/60/120 秒时间窗及 m/s²/g 单位。

网页默认通过 Web Serial 读取 USB 数据，采集时保存每条设备样本，图表仍约 5Hz 刷新。训练 CSV 使用设备采样时间，而不是浏览器收包时间。模型识别将最近窗口发送到本机 Python 服务，所有数据在电脑本地处理。蓝牙备用模式通过 Web Bluetooth 接收 BLE GATT 通知，不使用经典蓝牙 SPP。

## 导出训练 CSV

1. 连接 USB 后选择采集标签与人员编号（如 p01），准备好动作，再点击「开始采集」。
2. 持续做对应动作至少 20～60 秒，点击「停止采集」。采集期间标签锁定，防止误改。
3. 可以换标签再录一段，每次开始自动生成新的 session_id。所有片段可一次导出，也可分次导出；程序不会自动清空记录。
4. 点击「导出 CSV」，将文件放入 `motion_training/data` 后运行 `train.cmd --input data --output models`。
5. 每个类别至少采集两个独立场次，建议更多。清空前请先导出；刷新或关闭页面会丢失尚未导出的内存记录。

导出列：`timestamp_ms,accel_magnitude,label,session_id,person_id,sequence,ax,ay,az,gx,gy,gz`。单位固定 m/s²（含重力）、rad/s，网页选择 g 不影响 CSV。设备时间复位、断连或数据中断会停止采集，旧记录保留；网页显示估计采样率、丢包和长断点，不虚构补齐样本。容量上限为 300000 条。

## 电脑端运动识别

训练后生成 `motion_training/models/motion_model.joblib`，本地服务会自动检测并加载；无需刷新模型文件路径。模型需采用 50Hz 和 m/s² 输入。网页使用模型指定的窗口长度，每 0.5 秒调用本地 `/api/predict`，显示当前运动类型及置信度；低于 0.6 输出 UNKNOWN。当前没有真实训练数据时会显示“尚无模型”，不会用采集标签代替识别结果。

识别结果由网页通过同一个串口发送 `ACT,JUMPING_JACK,0.9200` 等命令，ESP32 的 TFT 底行显示动作缩写与概率。超过 3 秒没有结果时显示 `ACT: waiting for PC`。阈值是初始值，未做概率校准或时序平滑，之后应根据独立验证数据调整。

启动服务的 Python 需要训练依赖；此电脑优先使用已安装依赖的 Codex Python。其他电脑先按照 `motion_training/README.md` 安装依赖，再用同一 Python 运行 `dashboard/serve.py`。仅加载自己训练或可信来源的 joblib 模型。

## 显示的数据

- 心率：最近最多四次有效心跳间隔平均值；未检测到手指、无新样本或心率未稳定时显示 `—`。
- 加速度：X/Y/Z 和合加速度，包含重力，静止合加速度约 1g；不等同于已去重力的运动强度。
- 当前固件对 Z 轴使用初步校准 `(原始Z + 2.65) × (9.80665 / 10.05)`，依据该传感器朝上 +7.4、朝下 −12.7m/s² 的读数。网页直接使用固件传来的校正数据，无需再次校正。需要重新上传更新后的固件才能生效。
- 角速度：MPU6050 的 X/Y/Z 陀螺仪读数，单位 rad/s。
- 温度：MPU6050 **芯片温度**，不是人体体温。
- 红外原始值、手指接触、两传感器初始化状态、通知接收速率、设备运行时间。
- 超过 2.5 秒没有相应实时数据时清空数值。历史曲线仍保留最近时间窗，并随时间滚出。

尚未实现计步、距离、卡路里、血氧或电池电量。设备运行时间是 ESP32 启动后的毫秒计时，约 49.7 天回绕。

## 无法连接时

- 确认上传的是最新 `SmartSportBLE`，启动后串口 115200 会持续输出 `IMU,...,2`，目标 50Hz；旧程序没有该协议，无法采集训练数据。
- 使用电脑 Chrome/Edge；电脑需有可用的 BLE 蓝牙适配器。页面必须是 HTTPS 或 localhost，普通局域网 HTTP 页面不能使用 Web Bluetooth。
- 关闭其他已连接的网页或蓝牙调试软件；复位 ESP32 后重新选择设备。
- 在独立 Chrome/Edge 标签中打开，内嵌预览可能无法调用蓝牙。
- 如果网页找不到设备，先确认 ESP32 正常供电、串口没有重启日志，检查 GPIO12 的启动影响。
- 程序较大导致 Flash 空间不足时，在 Arduino IDE 的工具菜单选择容量适合实际 Flash 的大应用分区（常见 4MB WROOM 可使用 `Huge APP`）。实际板子 Flash 容量需核对。

## 本地打开

网站仅在本地运行，无需发布、登录或云服务。双击 **`start-dashboard.cmd`**，然后用 Chrome/Edge 打开 `http://localhost:8082/`。启动窗口保持打开，按 Ctrl+C 停止服务。

也可以在 `dashboard` 目录运行：

```powershell
python serve.py
```

如果提示 8082 端口已占用，先尝试打开网页；现有预览可能已启动。需要另用端口时：

```powershell
python serve.py --port 8081
```

然后打开 `http://localhost:8081/`。该服务仅监听本机 `127.0.0.1`。

仅查看静态网页时也可以在 `dashboard/dist` 目录运行下面的命令，但不会提供模型识别接口：

```powershell
python -m http.server 8080 --bind 127.0.0.1
```

用 Chrome 或 Edge 打开 `http://localhost:8082`。不要直接双击 HTML：模块脚本和蓝牙权限依赖正确的网页环境。

## USB 串口协议（版本 2）

ESP32 每次实际读数后发送一行：

```text
IMU,sequence,timestamp_ms,ax,ay,az,gx,gy,gz,temperature,bpm,ir,flags,2
```

目标 50Hz，无阻塞等待的串口命令解析；启动日志由网页忽略。固件在主循环采样，刷新 TFT 和 BLE 可能引入时间抖动，需以采集页面估计 Hz 与设备时间为准；长阻塞不会补发伪造样本。

电脑回传一行：`ACT,类别,0到1的概率`。支持 JUMPING_JACK、SQUAT、RUNNING、IDLE、OTHER、UNKNOWN。

## 蓝牙查看协议（版本 1）

Service UUID：`5a4f0001-9b7d-4f3a-8c2e-6d1b0a9f3456`。

Notify characteristic UUID：`5a4f0002-9b7d-4f3a-8c2e-6d1b0a9f3456`。

每个通知 20 字节，每 100ms 交替发送两种包，各类型约 5Hz，适配默认 MTU。所有多字节字段采用小端序；同一对包的序号相同，第二种包读取的是稍后的运动数据，并非同步快照。

| 偏移 | 类型 1：传感器 | 类型 2：运动 |
|---|---|---|
| 0 | 协议版本 uint8，值 1 | 同左 |
| 1 | 包类型 uint8，值 1 | 值 2 |
| 2 | 状态位 uint8 | 同左 |
| 3 | 保留 | 保留 |
| 4 | 序号 uint16 | 序号 uint16 |
| 6 | 心率 uint16，BPM ×10 | X 角速度 int16，rad/s ×1000 |
| 8 | X 加速度 int16，m/s² ×100 | Y 角速度 int16，rad/s ×1000 |
| 10 | Y 加速度 int16，m/s² ×100 | Z 角速度 int16，rad/s ×1000 |
| 12 | Z 加速度 int16，m/s² ×100 | 运行毫秒数 uint32 |
| 14 | IR uint32 | 运行时间后半段 |
| 18 | 芯片温度 int16，°C ×100 | 保留 |

状态位：bit0 MPU 初始化成功，bit1 MAX 初始化成功，bit2 手指接触，bit3 有效心率，bit4 TFT 使用 g，bit5 MAX 在最近 1 秒内有新样本。网页单位独立于 TFT 按键选择。

## 验证

运行 `node --test tests/protocol.test.mjs tests/app-state.test.mjs tests/training.test.mjs tests/serial-app.test.mjs` 检查协议、记录、CSV、分段串口读取与动作回传。`tests/backend_test.py` 使用模拟导出数据验证训练与识别接口。真实 USB/BLE 通信、50Hz 实际采样稳定性和固件编译仍需在设备与 Arduino IDE 上验证。

参考：[Chrome Web Bluetooth 文档](https://developer.chrome.com/docs/capabilities/bluetooth)、[乐鑫 BLE Notify 示例](https://github.com/espressif/arduino-esp32/blob/master/libraries/BLE/examples/Notify/Notify.ino)。
