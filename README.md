# homebridge-nuki-latch

A Homebridge plugin which improves Nuki support for doors with latches. In order
for this to work you also need the [Nuki Bridge](https://nuki.io/en/bridge/)
running in [developer
mode](https://nuki.io/en/support/bridge/bridge-features/manage-bridge-settings/).

## Usage

```json
{
  "accessories": [
    {
      "accessory": "NukiLatch",
      "name": "RealFakeDoor"
    }
  ]
}
```

## Development

Most of the code is build upon a homebridge plugin I build a while ago:
[homebridge-mqtt-lock](https://github.com/ream88/homebridge-mqtt-lock)

During development `rsync` helped a lot with syncing the plugin to my Raspberry
Pi which is running homebridge.

```sh
rsync -vr --exclude 'node_modules' --exclude '.git' . docker.local:/home/pi/homebridge/node_modules/homebridge-nuki-latch
```

## License

MIT License
