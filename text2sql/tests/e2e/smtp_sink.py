import asyncio, json, sys
from aiosmtpd.controller import Controller
class Sink:
    async def handle_DATA(self, server, session, envelope):
        open(sys.argv[1], "a").write(json.dumps({"to": envelope.rcpt_tos, "size": len(envelope.content)}) + "\n")
        return "250 OK"
c = Controller(Sink(), hostname="127.0.0.1", port=2525); c.start()
asyncio.new_event_loop().run_forever()
