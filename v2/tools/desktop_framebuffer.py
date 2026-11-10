"""Bounded native desktop input and PNG capture over a local, verified RFB socket."""
import socket
import struct
import time
import zlib

KEYS = {'Return': 0xff0d, 'Tab': 0xff09, 'Escape': 0xff1b,
        'BackSpace': 0xff08, 'Delete': 0xffff, 'Home': 0xff50, 'End': 0xff57,
        'Left': 0xff51, 'Up': 0xff52, 'Right': 0xff53, 'Down': 0xff54,
        'Page_Up': 0xff55, 'Page_Down': 0xff56, 'Shift_L': 0xffe1,
        'Control_L': 0xffe3, 'Alt_L': 0xffe9, 'space': 0x20}


def require(value, reason):
    if not value:
        raise ValueError(reason)


def png(pixels, width, height):
    require(0 < width * height <= 2 * 1024**2 and len(pixels) == width * height * 4,
            'framebuffer_size_invalid')
    # Requested little-endian 32-bit true color is B,G,R,pad.
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        row = pixels[y * width * 4:(y + 1) * width * 4]
        rgb = bytearray(width * 3)
        rgb[0::3], rgb[1::3], rgb[2::3] = row[2::4], row[1::4], row[0::4]
        rows.extend(rgb)
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return (b'\x89PNG\r\n\x1a\n' +
            chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


class Desktop:
    def __init__(self, port, timeout=8):
        require(type(port) is int and 1 <= port <= 65535, 'framebuffer_port_invalid')
        self.deadline = time.monotonic() + timeout
        self.socket = socket.create_connection(('127.0.0.1', port), timeout=timeout)

    def close(self):
        self.socket.close()

    def remaining(self):
        seconds = self.deadline - time.monotonic()
        require(seconds > 0, 'framebuffer_deadline')
        self.socket.settimeout(seconds)

    def read(self, size):
        result = bytearray()
        while len(result) < size:
            self.remaining()
            data = self.socket.recv(size - len(result))
            require(data, 'framebuffer_connection_closed')
            result.extend(data)
        return result

    def write(self, data):
        self.remaining()
        self.socket.sendall(data)

    def initialize(self):
        require(self.read(12) in (b'RFB 003.007\n', b'RFB 003.008\n'), 'framebuffer_protocol_invalid')
        self.write(b'RFB 003.008\n')
        count = self.read(1)[0]
        require(count and 1 in self.read(count), 'framebuffer_auth_required')
        self.write(b'\x01')
        require(self.read(4) == b'\0' * 4, 'framebuffer_auth_required')
        self.write(b'\x01')  # Shared: preserve owner viewers.
        init = self.read(24)
        self.width, self.height = struct.unpack_from('>HH', init)
        size = struct.unpack_from('>I', init, 20)[0]
        require(0 < self.width * self.height <= 2 * 1024**2 and size <= 4096,
                'framebuffer_size_invalid')
        self.read(size)
        self.write(bytes([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]))
        self.write(bytes([2, 0, 0, 1, 0, 0, 0, 0]))

    def pointer(self, x, y, button=0):
        require(type(x) is int and type(y) is int and 0 <= x < self.width and 0 <= y < self.height,
                'desktop_coordinates_invalid')
        require(type(button) is int and 0 <= button <= 5, 'desktop_button_invalid')
        self.write(struct.pack('>BBHH', 5, (1 << (button - 1)) if button else 0, x, y))
        if button:
            self.write(struct.pack('>BBHH', 5, 0, x, y))

    def key(self, key):
        require(key in KEYS, 'desktop_key_invalid')
        value = KEYS[key]
        self.write(struct.pack('>BBHI', 4, 1, 0, value))
        self.write(struct.pack('>BBHI', 4, 0, 0, value))

    def text(self, text):
        require(type(text) is str and 0 < len(text) <= 1024 and all(c.isprintable() for c in text),
                'desktop_text_invalid')
        for character in text:
            value = ord(character)
            if value > 255:
                value |= 0x01000000
            self.write(struct.pack('>BBHI', 4, 1, 0, value))
            self.write(struct.pack('>BBHI', 4, 0, 0, value))

    def screenshot(self):
        self.write(struct.pack('>BBHHHH', 3, 0, 0, 0, self.width, self.height))
        header = self.read(4)
        require(header[0] == 0 and struct.unpack_from('>H', header, 2)[0] == 1,
                'framebuffer_update_invalid')
        require(struct.unpack('>HHHHi', self.read(12)) == (0, 0, self.width, self.height, 0),
                'framebuffer_rectangle_invalid')
        return png(self.read(self.width * self.height * 4), self.width, self.height)
