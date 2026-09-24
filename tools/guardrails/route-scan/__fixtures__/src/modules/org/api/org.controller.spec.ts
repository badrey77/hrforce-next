import { Controller, Get } from '@nestjs/common';

// spec files are not scanned: this undecorated handler must not be reported
@Controller('spec-only')
export class SpecOnlyController {
  @Get()
  handler(): void {}
}
