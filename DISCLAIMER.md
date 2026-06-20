# Disclaimer

**This project is provided for educational, research, and personal
interoperability purposes only.**

## No affiliation

`whoof` is an independent, unofficial, third-party project. It is **not**
affiliated with, endorsed by, sponsored by, or in any way connected to
**WHOOP, Inc.** or any of its subsidiaries, partners, or affiliates.

WHOOP®, the WHOOP logo, "WHOOP 4.0", and related marks are trademarks or
registered trademarks of **WHOOP, Inc.** All trademarks are the property of
their respective owners. Any reference to WHOOP, Inc. or its products in this
project is made nominatively — that is, for the limited purpose of describing
which hardware this code is compatible with — and does not imply any
endorsement, sponsorship, partnership, or affiliation.

## Not medical or clinical software

The metrics computed by this software (heart rate, HRV, recovery, strain,
sleep stages, SpO₂, skin temperature, etc.) are derived from textbook
formulas applied to raw sensor data. They are:

- **Not** clinically validated.
- **Not** medical advice, diagnosis, treatment, or a substitute for the
  judgement of a qualified medical professional.
- **Not** suitable for any clinical, diagnostic, or therapeutic purpose.

If you have any health concerns, consult a licensed physician. **Do not**
use this software to make medical decisions for yourself or anyone else.

## No warranty

The software is provided "as is", without warranty of any kind, express or
implied, including but not limited to the warranties of merchantability,
fitness for a particular purpose, and non-infringement. In no event shall
the authors or copyright holders be liable for any claim, damages, or other
liability, whether in an action of contract, tort, or otherwise, arising
from, out of, or in connection with the software or the use or other
dealings in the software. See [LICENSE](LICENSE) (MIT).

## Reverse engineering & interoperability

The Bluetooth protocol details documented and exercised by this project
were obtained from publicly available reverse-engineering research
(see Credits in the README). The work performed here is intended solely to
achieve **interoperability** with hardware lawfully purchased and owned by
the end user — enabling the user to read sensor data from their own
device — and is performed in good faith reliance on applicable exceptions
to anti-circumvention law, including but not limited to 17 U.S.C. §1201(f)
in the United States and Article 6 of EU Directive 2009/24/EC.

This project does **not**:

- Bypass or circumvent any authentication, billing, or DRM system on
  WHOOP's cloud services.
- Access, scrape, or interact with WHOOP, Inc.'s servers, APIs, or
  subscriber accounts.
- Distribute, redistribute, or modify any WHOOP, Inc. proprietary
  firmware, software, brand assets, or other copyrighted materials.

It only reads raw sensor telemetry that the strap itself broadcasts to
its paired host over standard Bluetooth Low Energy, on hardware the user
owns.

## Acceptable use

By using this software you agree that you:

1. Own (or have explicit, lawful permission from the owner to use) any
   WHOOP 4.0 hardware you pair with it.
2. Will use the software solely for personal, educational, and research
   purposes.
3. Will not use the software to harm, defraud, or mislead WHOOP, Inc., its
   customers, or any third party.
4. Will not use the software for any medical, clinical, diagnostic, or
   therapeutic purpose.
5. Accept all risk arising from your use of the software.

## Takedown / contact

If you represent WHOOP, Inc. and have a concern about anything in this
repository, please open a GitHub issue at
<https://github.com/shams/whoof/issues> or contact the maintainer
directly. Reasonable, good-faith requests will be addressed promptly.
