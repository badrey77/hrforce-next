import { Body, Controller, Post } from '@nestjs/common';
import { Public } from '../../../platform/authz/decorators.js';
import { LoginRequestDto } from './login.dto.js';

@Controller('auth')
export class AuthController {
  @Post('login')
  @Public()
  login(@Body() body: LoginRequestDto): { user: string } {
    return { user: body.username, accessToken: 'leak' };
  }
}
