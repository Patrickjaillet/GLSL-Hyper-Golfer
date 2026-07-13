#define GET_X(p) (p.x + OFFSET)

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    float OFFSET = 1.0;
    fragColor = vec4(GET_X(fragCoord), 0.0, 0.0, 1.0);
}
