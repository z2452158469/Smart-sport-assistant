# 智能运动助手：硬件测试

测试程序：`SmartSportTest/SmartSportTest.ino`。

蓝牙实时仪表盘：上传 `SmartSportBLE/SmartSportBLE.ino`，使用电脑 Chrome/Edge 连接 **SmartSport-ESP32**。详细步骤见 [dashboard/README.md](dashboard/README.md)。网页显示心率、加速度、角速度、芯片温度及实时趋势，保留原接线与 TFT 显示。

电脑端动作模型训练程序位于 [motion_training/README.md](motion_training/README.md)：读取时间戳、合加速度和标签 CSV，训练随机森林，保存模型并支持离线预测。更新后的 SmartSportBLE 固件通过 USB 串口发送目标 50Hz 数据；dashboard 支持标注导出，加载训练模型并回传动作状态给 TFT。原低频蓝牙模式仍用于数据查看。

## 适用硬件与接线

默认使用经典 ESP32 DevKit / ESP32-WROOM-32、**ST7735 驱动的 1.8 寸 128×160 SPI TFT**、MPU6050 模块、MAX30102 模块和瞬时按键。ESP32-C3/S3 或其他屏幕驱动需修改配置；仅凭屏幕尺寸无法确认驱动型号。

拓展板用于引出对应 GPIO，请按 GPIO 编号接线。

| 模块 | 模块引脚 | ESP32 |
|---|---|---|
| TFT | VCC、GND | 3V3、GND |
| TFT | SCL / SCK / CLK | GPIO2 |
| TFT | SDA / MOSI / DIN | GPIO4 |
| TFT | CS | GPIO14 |
| TFT | DC / A0 / RS | GPIO13 |
| TFT | RES / RST | GPIO12 |
| TFT | BL / LED | 按模块说明接背光电源，常见模块接 3V3 |
| MPU6050 | VCC、GND | 3V3、GND |
| MPU6050 | SDA、SCL | GPIO21、GPIO22 |
| MPU6050 | AD0 | GND（地址 0x68）；程序也尝试 0x69 |
| MAX30102 | VIN / VCC、GND | 模块支持 3.3V 输入时接 3V3、GND |
| MAX30102 | SDA、SCL | GPIO21、GPIO22 |
| 按键 | 两端 | GPIO36、GND |
| 按键上拉电阻 | 10kΩ 两端 | GPIO36、3V3 |

MPU6050 和 MAX30102 共用 I2C；TFT 上标为 SDA/SCL 的引脚在这里是 **SPI**，不要接到传感器 I2C 总线上。两块传感器的 INT 无需连接。四脚按键应使用按下才导通的两端。

GPIO36 没有内部上拉/下拉，程序使用 `INPUT`。按键松开为高电平、按下接地为低电平；如果拓展板或按键模块已有上拉电阻，无需重复添加。

GPIO2 和 GPIO12 是启动配置引脚。对于常见使用 3.3V Flash 的 ESP32-WROOM，屏幕 RES 上的外部上拉若在复位时把 GPIO12 拉高，可能导致无法启动；可将 RES 改接 GPIO26，并同步修改 `TFT_RST`。GPIO2 若被外部电路拉高，也可能影响串口下载；下载失败时可先断开 TFT 的 SCL 后重试。参见 [Espressif ESP32 数据手册](https://www.espressif.com/sites/default/files/documentation/esp32_datasheet_en.pdf)。

所有模块共地，GPIO 使用 3.3V 电平。这里指带外围电路的模块，不是裸传感器芯片；尤其 MAX30102 裸芯片不能直接按本表供电。确认模块电源要求及 I2C 上拉电压，避免将 GPIO 上拉到 5V。背光裸 LED 需按规格限流。

## 安装与上传

1. Arduino IDE 的开发板管理器安装 Espressif 的 `esp32`，选择实际板型（常见 WROOM 开发板可选择 `ESP32 Dev Module`）及串口。
2. 库管理器安装以下库，并接受依赖库安装：
   - `Adafruit GFX Library`
   - `Adafruit ST7735 and ST7789 Library`
   - `Adafruit MPU6050`
   - `Adafruit Unified Sensor`
   - `Adafruit BusIO`
   - `SparkFun MAX3010x Pulse and Proximity Sensor Library`
3. 打开 `SmartSportTest/SmartSportTest.ino`，核对顶部引脚常量，然后验证、上传。
4. 串口监视器设置为 **115200**。屏幕每 200ms 刷新，加速度每 50ms 读取，心率样本持续读取。

## 测试现象

Z 轴已加入初步校准：根据静止朝上 +7.4、朝下 −12.7m/s²，使用 `(原始Z + 2.65) × (9.80665 / 10.05)`。X、Y 保持原读数。测试版与蓝牙版均在读取传感器后校正，TFT、串口、蓝牙以及网页的合加速度统一使用校正值；网页无需重复校正。系数位于程序顶部 `ACCEL_Z_OFFSET` 与 `ACCEL_Z_SCALE`。这些是近似测量得到的系数，之后可用更长时间平均值重新校准。

- 屏幕 `HR` 显示最近最多四次有效心跳间隔的平均心率，单位 BPM。没有结果时显示 `--`；放好手指后先等待滤波稳定及至少两次心跳检测，通常需要数秒。
- 用指腹轻贴 MAX30102，保持稳定，避免用力挤压及强光直射。运动时的光学心率易受干扰，本程序用于静止状态硬件测试，未实现运动伪影抑制。
- `X/Y/Z` 是三轴加速度，`A` 是合加速度，默认单位 m/s²。按键切换为 g。数据**包含重力**：静放时合加速度约 9.81m/s²（1g），不是零；翻转模块可观察轴方向变化。
- `IR` 是红外原始值，用于辅助判断手指检测。默认阈值 `FINGER_IR_THRESHOLD = 50000`；如果放手指后仍提示 `Place finger`，观察无手指和有手指的 IR 值，将阈值设在两者之间。不能仅凭 IR 数值判断心率是否准确。
- 传感器初始化失败显示 `NOT FOUND`；MAX30102 超过 1 秒没有样本显示 `NO DATA`。检查供电、接线后复位重试。
- 黑屏：先检查背光、供电、CS/DC/RST 与 SPI 接线，再确认屏幕驱动。显示偏移或颜色异常：尝试将 `INITR_BLACKTAB` 改为 `INITR_GREENTAB` 或 `INITR_REDTAB`；若是 ST7789/ILI 系列，需要更换屏幕驱动代码。

## 实现参考与验证状态

心率使用 [SparkFun MAX3010x 库](https://github.com/sparkfun/SparkFun_MAX3010x_Sensor_Library) 的 `checkForBeat`，该库虽然头文件名为 MAX30105，也支持 MAX30102。显示使用 [Adafruit ST7735 库](https://github.com/adafruit/Adafruit-ST7735-Library)，加速度使用 [Adafruit MPU6050 库](https://github.com/adafruit/Adafruit_MPU6050)。

当前环境未发现 Arduino CLI 或 PlatformIO，尚未实际编译或在硬件上验证。最终接线和屏幕初始化参数需与你手上的模块一致。
