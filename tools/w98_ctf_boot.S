.code16
.org 0

/*
 * Tiny BIOS-level reverse challenge.
 *
 * The expected flag is intentionally stored only as bytes XORed with
 * xor_key. A participant can recover it by reversing decode_loop and the
 * encoded table; the plaintext flag never appears in this source file.
 */
start:
  cli
  xorw %ax, %ax
  movw %ax, %ds
  movw %ax, %ss
  movw $0x7c00, %sp
  sti

  movw $banner, %si
  call print
  movw $prompt, %si
  call print

read_loop:
  xorw %ax, %ax
  int $0x16
  cmpb $13, %al
  je check_flag
  cmpb $8, %al
  je backspace
  cmpb $31, input_len
  jae read_loop
  xorw %bx, %bx
  movb input_len, %bl
  movb %al, input(%bx)
  incb input_len
  movb $0x0e, %ah
  int $0x10
  jmp read_loop

backspace:
  cmpb $0, input_len
  je read_loop
  decb input_len
  movb $8, %al
  movb $0x0e, %ah
  int $0x10
  movb $' ', %al
  int $0x10
  movb $8, %al
  int $0x10
  jmp read_loop

check_flag:
  movw $crlf, %si
  call print

  /* Decode the embedded table into a scratch buffer before comparing. */
  movw $encoded, %si
  movw $decoded, %di
  movw $flag_len, %cx
decode_loop:
  lodsb
  xorb $xor_key, %al
  stosb
  loop decode_loop

  cmpb $flag_len, input_len
  jne fail
  xorw %bx, %bx
  movw $flag_len, %cx
compare_loop:
  movb input(%bx), %dl
  cmpb decoded(%bx), %dl
  jne fail
  incw %bx
  loop compare_loop

  movw $success, %si
  call print
  jmp halt

fail:
  movw $failure, %si
  call print

halt:
  cli
1: hlt
  jmp 1b

print:
  lodsb
  testb %al, %al
  jz 2f
  movb $0x0e, %ah
  int $0x10
  jmp print
2: ret

banner: .asciz "WASM98 CTF #1\r\nEasy XOR reverse challenge\r\n"
prompt: .asciz "Enter flag: "
crlf: .asciz "\r\n"
success: .asciz "[+] Correct! You found the flag.\r\n"
failure: .asciz "[-] Wrong flag. Try again.\r\n"

/* 27 bytes, each plaintext byte XORed with 0x5a. */
encoded: .byte 0x39,0x34,0x29,0x29,0x21,0x2d,0x69,0x36,0x39,0x6a,0x37,0x69,0x05,0x2e,0x6a,0x05,0x2d,0x6b,0x34,0x3e,0x6a,0x2d,0x6f,0x05,0x63,0x62,0x27
flag_len = . - encoded
xor_key = 0x5a

input_len: .byte 0
input: .space 31
decoded: .space flag_len

.org 510
.word 0xaa55
